import type { Request, Response } from "express";

export function mockReq(body: unknown): Partial<Request> {
  return { body };
}

export function mockRes() {
  const res: Partial<Response> & {
    statusCode?: number;
    jsonBody?: any;
  } = {};

  res.statusCode = 200;

  res.status = function (code: number) {
    res.statusCode = code;
    return res as any;
  };

  res.json = function (body: any) {
    res.jsonBody = body;
    return res as any;
  };

  return res;
}
