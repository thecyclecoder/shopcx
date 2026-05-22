/**
 * Portal logout — clears all session cookies (magic-link + legacy)
 * and redirects to the login page.
 *
 * Path on the custom portal subdomain: /logout (middleware rewrites
 * to /portal/{slug}/logout). On shopcx.ai the path is the full
 * /portal/{slug}/logout. Either way ends at this server component.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function PortalLogout({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const cookieStore = await cookies();
  const headerStore = await headers();

  // Delete every cookie that might hold a customer session. Setting
  // explicit empty value + expires-in-the-past covers browsers that
  // don't honor cookies().delete() (older Safari) AND keeps the
  // matching path/Secure flags so the browser actually drops the
  // cookie instead of treating it as a different one.
  for (const name of ["portal_customer_id", "portal_workspace_id", "portal_session"]) {
    cookieStore.set({
      name,
      value: "",
      path: "/",
      maxAge: 0,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }

  // On the customer-facing subdomain (portal.example.com) middleware
  // rewrites /login → /portal/{slug}/login, so the URL bar stays
  // clean. On shopcx.ai we don't have that rewrite, so target the
  // full path.
  const host = headerStore.get("host") || "";
  const isOnCustomDomain = !host.endsWith("shopcx.ai") && !host.includes("localhost") && !host.includes("127.0.0.1");
  const target = isOnCustomDomain ? "/login" : `/portal/${slug}/login`;

  redirect(target);
}
