const crypto = require("crypto");
const { getConfig } = require("./config");
const { unavailable } = require("./errors");

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const DEVELOPMENT_PEPPER = crypto.randomBytes(32);

function getPepper() {
  const configured = getConfig().otpPepper;
  if (configured && Buffer.byteLength(configured, "utf8") >= 32) return Buffer.from(configured, "utf8");
  if (getConfig().isProduction) throw unavailable("Client sign-in verification is not configured.");
  if (configured) throw unavailable("Client sign-in verification is not configured.");
  return DEVELOPMENT_PEPPER;
}

function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function hashOtp(otp, challengeHash, clientId) {
  return crypto.createHmac("sha256", getPepper())
    .update(`${challengeHash}\0${clientId}\0${otp}`)
    .digest("hex");
}

function hashChallengeId(id) {
  return crypto.createHash("sha256").update(id).digest("hex");
}

function safeEqualHex(left, right) {
  if (!/^[0-9a-f]{64}$/.test(left || "") || !/^[0-9a-f]{64}$/.test(right || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function maskEmail(email) {
  const [name, domain] = String(email).split("@");
  if (!domain) return "";
  const visible = name.length > 1 ? name.slice(0, 1) : "";
  return `${visible}${"*".repeat(Math.max(3, Math.min(name.length - visible.length, 8)))}@${domain}`;
}

function createMailer() {
  return {
    async sendOtp(email, otp) {
      const config = getConfig().smtp();
      if (!config.host || !config.from) {
        throw unavailable("Email verification is temporarily unavailable. Configure SMTP and try signing in again.");
      }
      const isGmail = config.host.toLowerCase() === "smtp.gmail.com";
      if (isGmail && (!config.username || !config.password)) {
        throw unavailable("Gmail SMTP requires SMTP_USERNAME and SMTP_PASSWORD to be configured.");
      }
      if (isGmail && !((config.port === 587 && !config.secure) || (config.port === 465 && config.secure))) {
        throw unavailable("Gmail SMTP must use port 587 with STARTTLS or port 465 with TLS.");
      }
      const nodemailer = require("nodemailer");
      const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        requireTLS: isGmail && config.port === 587,
        auth: config.username ? { user: config.username, pass: config.password } : undefined,
        tls: { rejectUnauthorized: config.rejectUnauthorized },
      });
      try {
        await transport.sendMail({
          from: config.from,
          to: email,
          subject: "Your MAESTRO DBaaS verification code",
          text: `Your MAESTRO DBaaS verification code is ${otp}. It expires in five minutes. If you did not request this code, ignore this email.`,
        });
      } finally {
        transport.close();
      }
    },
  };
}

module.exports = {
  OTP_TTL_MS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_MAX_ATTEMPTS,
  generateOtp,
  hashOtp,
  hashChallengeId,
  safeEqualHex,
  maskEmail,
  createMailer,
};
