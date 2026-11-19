// Outgoing email through SMTP (Gmail by default, using a Gmail App Password).
import nodemailer from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

/** Sends the email. Throws if SMTP is configured but sending fails. Returns false if SMTP isn't configured. */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (!smtpConfigured()) return false;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER as string;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port,
    secure: port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user, pass: (process.env.SMTP_PASS as string).replace(/\s+/g, "") }, // App Passwords are shown with spaces
  });
  await transport.sendMail({
    from: process.env.MAIL_FROM || `GodownBook <${user}>`,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  return true;
}
