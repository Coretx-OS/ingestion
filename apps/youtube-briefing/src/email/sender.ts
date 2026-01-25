/**
 * Email Sender
 * 
 * Sends digests via Resend email service.
 */

import { Resend } from 'resend';
import { formatDigestHtml, formatDigestText, type Digest } from '../digest/generator.js';
import { getDb } from '../db/connection.js';
import { randomUUID } from 'crypto';

export interface EmailConfig {
  to: string;
  from?: string;
  replyTo?: string;
}

export interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

let resendClient: Resend | null = null;

function getResend(): Resend {
  if (resendClient) return resendClient;
  
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable is required');
  }
  
  resendClient = new Resend(apiKey);
  return resendClient;
}

/**
 * Send a digest via email
 */
export async function sendDigestEmail(
  digest: Digest,
  config: EmailConfig
): Promise<SendResult> {
  const resend = getResend();
  
  const from = config.from || process.env.EMAIL_FROM || 'briefing@secondbrain.local';
  const subject = `📺 Daily YouTube Briefing - ${digest.bullets.length} insights, ${digest.minutesSaved} min saved`;
  
  const html = formatDigestHtml(digest);
  const text = formatDigestText(digest);
  
  try {
    const result = await resend.emails.send({
      from,
      to: config.to,
      replyTo: config.replyTo,
      subject,
      html,
      text,
    });
    
    // Store email record
    const db = getDb();
    db.prepare(`
      INSERT INTO email_log (id, digest_id, recipient, status, message_id, sent_at)
      VALUES (?, ?, ?, 'sent', ?, datetime('now'))
    `).run(randomUUID(), digest.id, config.to, result.data?.id || null);
    
    return {
      success: true,
      messageId: result.data?.id,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    
    // Log failed attempt
    const db = getDb();
    db.prepare(`
      INSERT INTO email_log (id, digest_id, recipient, status, error_message, sent_at)
      VALUES (?, ?, ?, 'failed', ?, datetime('now'))
    `).run(randomUUID(), digest.id, config.to, errorMsg);
    
    return {
      success: false,
      error: errorMsg,
    };
  }
}

/**
 * Send digest to all subscribers for a profile
 */
export async function sendDigestToSubscribers(digest: Digest): Promise<{
  sent: number;
  failed: number;
  results: Array<{ email: string; result: SendResult }>;
}> {
  const db = getDb();
  
  const subscribers = db.prepare(`
    SELECT email FROM email_subscribers
    WHERE profile_id = ? AND is_active = 1
  `).all(digest.profileId) as Array<{ email: string }>;
  
  const results: Array<{ email: string; result: SendResult }> = [];
  let sent = 0;
  let failed = 0;
  
  for (const subscriber of subscribers) {
    const result = await sendDigestEmail(digest, { to: subscriber.email });
    results.push({ email: subscriber.email, result });
    
    if (result.success) {
      sent++;
    } else {
      failed++;
    }
  }
  
  return { sent, failed, results };
}

/**
 * Add an email subscriber
 */
export function addSubscriber(profileId: string, email: string): void {
  const db = getDb();
  
  db.prepare(`
    INSERT INTO email_subscribers (id, profile_id, email, is_active)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(profile_id, email) DO UPDATE SET is_active = 1
  `).run(randomUUID(), profileId, email);
}

/**
 * Remove an email subscriber
 */
export function removeSubscriber(profileId: string, email: string): void {
  const db = getDb();
  
  db.prepare(`
    UPDATE email_subscribers SET is_active = 0
    WHERE profile_id = ? AND email = ?
  `).run(profileId, email);
}

/**
 * List subscribers for a profile
 */
export function listSubscribers(profileId: string): Array<{ email: string; isActive: boolean }> {
  const db = getDb();
  
  const rows = db.prepare(`
    SELECT email, is_active FROM email_subscribers
    WHERE profile_id = ?
    ORDER BY email
  `).all(profileId) as Array<{ email: string; is_active: number }>;
  
  return rows.map(row => ({
    email: row.email,
    isActive: row.is_active === 1,
  }));
}
