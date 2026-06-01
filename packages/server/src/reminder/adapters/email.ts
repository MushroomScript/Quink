import nodemailer from 'nodemailer';
import type { AdapterFn } from '../types.js';

// 邮件 adapter: nodemailer SMTP
// config: { host, port, secure?, user, pass, from, to }
export const emailAdapter: AdapterFn = async (ctx) => {
  const c = ctx.config;
  if (!c.host || !c.port || !c.user || !c.pass || !c.from || !c.to) {
    throw new Error('email config 缺字段: 需要 host/port/user/pass/from/to');
  }
  const transport = nodemailer.createTransport({
    host: c.host,
    port: Number(c.port),
    secure: c.secure ?? Number(c.port) === 465,
    auth: { user: c.user, pass: c.pass },
  });
  await transport.sendMail({
    from: c.from,
    to: c.to,
    subject: ctx.payload.title,
    text: ctx.payload.body,
  });
};
