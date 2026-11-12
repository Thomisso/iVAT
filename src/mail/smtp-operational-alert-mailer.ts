import type { OperationalAlertMailer } from "@/application/operational-alert-worker";
import { managedSmtpTransport, type SmtpConfiguration } from "./smtp-transport";

/** SMTP acceptance is not inbox delivery. Uncertain outcomes are never retried. */
export function smtpOperationalAlertMailer(configuration: SmtpConfiguration): OperationalAlertMailer {
  const transport = managedSmtpTransport(configuration);
  return {
    async send(message) {
      try {
        const receipt = await transport.sendMail({
          from: { name: "iVAT", address: configuration.sender }, to: { address: message.to, name: "" },
          subject: message.subject, text: message.text, html: message.html, messageId: message.messageId,
        });
        if (receipt.accepted.length === 1) return "accepted";
        if (receipt.rejected.length > 0) return "refused";
        return "unknown";
      } catch (error) {
        const responseCode = (error as { responseCode?: number }).responseCode;
        // A negative SMTP reply proves nonacceptance; a disconnect/timeout does not.
        if (responseCode && responseCode >= 400 && responseCode < 600) return "refused";
        return "unknown";
      }
    },
  };
}
