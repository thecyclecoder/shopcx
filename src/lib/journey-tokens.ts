import { randomBytes } from "crypto";

export function generateJourneyToken(): string {
  return randomBytes(36).toString("base64url"); // 48 char URL-safe token
}

export function getJourneyUrl(token: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai";
  return `${baseUrl}/journey/${token}`;
}
