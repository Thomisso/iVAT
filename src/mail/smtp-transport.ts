import nodemailer from "nodemailer";

export type SmtpConfiguration = {
  host: string; port: number; user?: string; password?: string; sender: string; localCapture?: boolean;
};

/** Authenticated TLS in production; explicit loopback capture only for local tests. */
export function managedSmtpTransport(configuration: SmtpConfiguration) {
  const local = configuration.localCapture === true && ["127.0.0.1", "localhost", "::1"].includes(configuration.host);
  if (!configuration.host || !Number.isInteger(configuration.port) || configuration.port < 1
    || configuration.port > 65535 || (!local && (!configuration.user || !configuration.password))) {
    throw new Error("SMTP configuration is incomplete");
  }
  return nodemailer.createTransport({
    host: configuration.host, port: configuration.port,
    secure: !local && configuration.port === 465,
    requireTLS: !local && configuration.port !== 465,
    auth: local ? undefined : { user: configuration.user!, pass: configuration.password! },
    logger: false, debug: false,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    disableFileAccess: true, disableUrlAccess: true,
  });
}
