jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));

const nodemailer = require("nodemailer");
const { createMailer } = require("../../dbaas/client-otp");

const SMTP_ENV = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SMTP_FROM",
  "SMTP_TLS_REJECT_UNAUTHORIZED",
];
const originalEnv = {};
let transport;

beforeEach(() => {
  for (const key of SMTP_ENV) originalEnv[key] = process.env[key];
  process.env.SMTP_HOST = "smtp.gmail.com";
  process.env.SMTP_PORT = "587";
  process.env.SMTP_SECURE = "false";
  process.env.SMTP_USERNAME = "portal@example.test";
  process.env.SMTP_PASSWORD = "not-a-real-app-password";
  process.env.SMTP_FROM = "portal@example.test";
  delete process.env.SMTP_TLS_REJECT_UNAUTHORIZED;
  transport = { sendMail: jest.fn().mockResolvedValue({}), close: jest.fn() };
  nodemailer.createTransport.mockReset().mockReturnValue(transport);
});

afterEach(() => {
  for (const key of SMTP_ENV) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test("Gmail SMTP on port 587 requires STARTTLS and authenticates without exposing configuration", async () => {
  await createMailer().sendOtp("client@example.test", "123456");
  expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: "portal@example.test", pass: "not-a-real-app-password" },
    tls: { rejectUnauthorized: true },
  }));
  expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
    from: "portal@example.test",
    to: "client@example.test",
  }));
  expect(transport.close).toHaveBeenCalledTimes(1);
});

test("Gmail SMTP accepts implicit TLS on port 465", async () => {
  process.env.SMTP_PORT = "465";
  process.env.SMTP_SECURE = "true";
  await createMailer().sendOtp("client@example.test", "123456");
  expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
    port: 465,
    secure: true,
    requireTLS: false,
  }));
});

test("Gmail SMTP rejects missing authentication or an inconsistent TLS mode", async () => {
  process.env.SMTP_PASSWORD = "";
  await expect(createMailer().sendOtp("client@example.test", "123456"))
    .rejects.toThrow("Gmail SMTP requires SMTP_USERNAME and SMTP_PASSWORD");
  expect(nodemailer.createTransport).not.toHaveBeenCalled();

  process.env.SMTP_PASSWORD = "not-a-real-app-password";
  process.env.SMTP_SECURE = "true";
  await expect(createMailer().sendOtp("client@example.test", "123456"))
    .rejects.toThrow("Gmail SMTP must use port 587 with STARTTLS or port 465 with TLS");
  expect(nodemailer.createTransport).not.toHaveBeenCalled();
});
