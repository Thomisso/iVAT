import nodemailer from "nodemailer";
import type { InvitationMailer } from "@/application/memberships";

export type InvitationEmailContent = {
  subject: string;
  heading: string;
  introduction: string;
  linkLabel: string;
  expiry: string;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** Same managed SMTP mailbox as Auth; Invitations carry their own application link. */
export function smtpInvitationMailer(configuration: {
  host: string;
  port: number;
  user?: string;
  password?: string;
  sender: string;
  localCapture?: boolean;
}, content: InvitationEmailContent): InvitationMailer {
  const local = configuration.localCapture === true && ["127.0.0.1", "localhost", "::1"].includes(configuration.host);
  if (!configuration.host || !Number.isInteger(configuration.port) || configuration.port < 1
    || configuration.port > 65535 || (!local && (!configuration.user || !configuration.password))) {
    throw new Error("SMTP configuration is incomplete");
  }
  const transport = nodemailer.createTransport({
    host: configuration.host, port: configuration.port,
    secure: !local && configuration.port === 465,
    requireTLS: !local && configuration.port !== 465,
    auth: local ? undefined : { user: configuration.user!, pass: configuration.password! },
    logger: false, debug: false,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return {
    async sendInvitation({ email, acceptUrl }) {
      await transport.sendMail({
        from: { name: "iVAT", address: configuration.sender }, to: { address: email, name: "" },
        subject: content.subject,
        text: `${content.heading}\n\n${content.introduction}\n${acceptUrl}\n\n${content.expiry}`,
        html: `<h2>${escapeHtml(content.heading)}</h2><p>${escapeHtml(content.introduction)}</p><p><a href="${escapeHtml(acceptUrl)}">${escapeHtml(content.linkLabel)}</a></p><p>${escapeHtml(content.expiry)}</p>`,
      });
    },
  };
}
