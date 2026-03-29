import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";

export interface PortalAuthResult {
  shop: string;
  loggedInCustomerId: string;
  workspaceId: string;
}

export interface RouteContext {
  req: NextRequest;
  url: URL;
  auth: PortalAuthResult;
  route: string;
}

export type RouteHandler = (ctx: RouteContext) => Promise<NextResponse>;
