import { managedSmtpTransport, type SmtpConfiguration } from "./smtp-transport";
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
export function smtpInvitationMailer(configuration: SmtpConfiguration, content: InvitationEmailContent): InvitationMailer {
  const transport = managedSmtpTransport(configuration);
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
