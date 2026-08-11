#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";

function parseArgs(argv) {
  const args = {
    date: taipeiDate(),
    advicePath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--date") {
      args.date = argv[++index];
    } else if (arg === "--advice-path") {
      args.advicePath = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function taipeiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function encodeBase64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function normalizeRecipients(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function createMessage({ from, to, subject, text }) {
  const boundary = `marketpulse-${Date.now()}`;
  const encodedSubject = `=?UTF-8?B?${encodeBase64(subject)}?=`;
  return [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || "";
      if (/^\d{3} /.test(last)) {
        socket.off("data", onData);
        socket.off("error", reject);
        resolve(buffer);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

async function command(socket, line, expectedCodes) {
  socket.write(`${line}\r\n`);
  const response = await readResponse(socket);
  const code = Number(response.slice(0, 3));
  if (!expectedCodes.includes(code)) {
    throw new Error(`SMTP command failed: ${line}; response: ${response.trim()}`);
  }
  return response;
}

function connectPlain(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => resolve(socket));
    socket.once("error", reject);
  });
}

function connectTls(host, port) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => resolve(socket));
    socket.once("error", reject);
  });
}

async function startTls(socket, host) {
  await command(socket, "STARTTLS", [220]);
  return tls.connect({ socket, servername: host });
}

async function sendMail({ host, port, secure, username, password, from, to, subject, text }) {
  let socket = secure ? await connectTls(host, port) : await connectPlain(host, port);
  await readResponse(socket);
  await command(socket, "EHLO marketpulse-taiwan", [250]);

  if (!secure) {
    socket = await startTls(socket, host);
    await command(socket, "EHLO marketpulse-taiwan", [250]);
  }

  await command(socket, "AUTH LOGIN", [334]);
  await command(socket, encodeBase64(username), [334]);
  await command(socket, encodeBase64(password), [235]);
  await command(socket, `MAIL FROM:<${from}>`, [250]);
  for (const recipient of to) {
    await command(socket, `RCPT TO:<${recipient}>`, [250, 251]);
  }
  await command(socket, "DATA", [354]);
  socket.write(`${createMessage({ from, to, subject, text })}\r\n.\r\n`);
  await readResponse(socket);
  await command(socket, "QUIT", [221]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const advicePath = args.advicePath || `runs/${args.date}/daily-investment-advice.md`;
  const text = await readFile(advicePath, "utf8");
  const host = requiredEnv("SMTP_HOST");
  const port = Number(process.env.SMTP_PORT || 587);
  const username = requiredEnv("SMTP_USER");
  const password = requiredEnv("SMTP_PASS");
  const to = normalizeRecipients(requiredEnv("MAIL_TO"));
  const from = process.env.MAIL_FROM || username;
  const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

  await sendMail({
    host,
    port,
    secure,
    username,
    password,
    from,
    to,
    subject: `台股市場脈衝每日投資建議 ${args.date}`,
    text,
  });
  process.stdout.write(`sent daily advice email to ${to.join(", ")}\n`);
}

main().catch((error) => {
  process.stderr.write(`ERROR: ${error.message}\n`);
  process.exitCode = 2;
});
