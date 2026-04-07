// EasyPost return label integration — rate quotes, label purchase, tracking

import EasyPostClient from "@easypost/api";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

// ── Types ──

export interface ReturnShippingRateParams {
  customerAddress: {
    name: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    phone?: string;
  };
  lineItems: {
    title: string;
    quantity: number;
    weight?: number | null; // ounces
    weightUnit?: string | null; // "g", "kg", "oz", "lb"
  }[];
}

export interface ReturnShippingRate {
  shipmentId: string;
  rate: {
    id: string;
    carrier: string;
    service: string;
    costCents: number;
    estimatedDays: number | null;
  };
}

export interface PurchasedLabel {
  trackingNumber: string;
  labelUrl: string;
  carrier: string;
  costCents: number;
}

export interface TrackingStatus {
  status: string;
  estimatedDelivery: string | null;
  events: {
    status: string;
    message: string;
    datetime: string;
    city?: string;
    state?: string;
    zip?: string;
  }[];
}

// ── Helpers ──

/** Convert weight to ounces */
function toOunces(weight: number, unit: string): number {
  switch (unit.toLowerCase()) {
    case "oz":
      return weight;
    case "lb":
      return weight * 16;
    case "g":
      return weight * 0.035274;
    case "kg":
      return weight * 35.274;
    default:
      return weight; // Assume ounces
  }
}

// ── Core Functions ──

/**
 * Get an EasyPost client for a workspace.
 * Checks easypost_test_mode toggle and uses the corresponding key.
 * Pass `mode` to override the toggle (e.g. when testing a specific key).
 */
export async function getEasyPostClient(
  workspaceId: string,
  mode?: "test" | "live",
): Promise<InstanceType<typeof EasyPostClient>> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("easypost_test_api_key_encrypted, easypost_live_api_key_encrypted, easypost_test_mode")
    .eq("id", workspaceId)
    .single();

  const useTest = mode ? mode === "test" : (ws?.easypost_test_mode ?? true);
  const encryptedKey = useTest
    ? ws?.easypost_test_api_key_encrypted
    : ws?.easypost_live_api_key_encrypted;

  if (!encryptedKey) {
    throw new Error(`EasyPost ${useTest ? "test" : "live"} API key not configured for this workspace`);
  }

  const apiKey = decrypt(encryptedKey);
  return new EasyPostClient(apiKey);
}

/**
 * Check if workspace is in EasyPost test mode.
 */
export async function isTestMode(workspaceId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("easypost_test_mode")
    .eq("id", workspaceId)
    .single();
  return ws?.easypost_test_mode ?? true;
}

/**
 * Re-fetch a shipment to check for rate adjustments after delivery.
 * Returns the actual cost (may differ from original quote if carrier adjusted).
 */
export async function getActualShippingCost(
  workspaceId: string,
  shipmentId: string,
): Promise<{ actualCostCents: number; adjusted: boolean }> {
  const client = await getEasyPostClient(workspaceId);
  const shipment = await client.Shipment.retrieve(shipmentId);

  const quotedCents = Math.round(parseFloat(shipment.selected_rate?.rate || "0") * 100);

  // Check for fee adjustments
  const fees = (shipment.fees || []) as { type: string; amount: string }[];
  const adjustmentFees = fees.filter((f) => f.type === "AdjustmentFee" || f.type === "PostageFee");
  const totalFeeCents = adjustmentFees.reduce((sum, f) => sum + Math.round(parseFloat(f.amount) * 100), 0);

  const actualCostCents = quotedCents + totalFeeCents;

  return {
    actualCostCents,
    adjusted: totalFeeCents !== 0,
  };
}

/**
 * Get workspace return address and default parcel dimensions.
 */
async function getWorkspaceReturnConfig(workspaceId: string) {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("return_address, default_return_parcel")
    .eq("id", workspaceId)
    .single();

  if (!ws?.return_address) {
    throw new Error("Return address not configured for this workspace");
  }

  const defaultParcel = (ws.default_return_parcel as {
    length: number;
    width: number;
    height: number;
    weight: number;
  }) || { length: 12, width: 10, height: 6, weight: 16 };

  return {
    returnAddress: ws.return_address as {
      name: string;
      street1: string;
      street2?: string;
      city: string;
      state: string;
      zip: string;
      country: string;
      phone?: string;
    },
    defaultParcel,
  };
}

/**
 * Phase 1: Get a return shipping rate quote (creates shipment, does NOT buy).
 * The shipment ID is stored in playbook_context for later purchase.
 */
export async function getReturnShippingRate(
  workspaceId: string,
  params: ReturnShippingRateParams,
): Promise<ReturnShippingRate> {
  const client = await getEasyPostClient(workspaceId);
  const { returnAddress, defaultParcel } = await getWorkspaceReturnConfig(workspaceId);

  // Calculate total weight from line items
  let totalWeightOz = 0;
  let hasWeight = false;
  for (const item of params.lineItems) {
    if (item.weight && item.weightUnit) {
      totalWeightOz += toOunces(item.weight, item.weightUnit) * item.quantity;
      hasWeight = true;
    }
  }

  // Fall back to default parcel weight if no item weights
  if (!hasWeight || totalWeightOz <= 0) {
    totalWeightOz = defaultParcel.weight;
  }

  // Create shipment with is_return: true — just to get rates, don't buy
  const shipment = await client.Shipment.create({
    from_address: {
      name: params.customerAddress.name,
      street1: params.customerAddress.street1,
      street2: params.customerAddress.street2 || undefined,
      city: params.customerAddress.city,
      state: params.customerAddress.state,
      zip: params.customerAddress.zip,
      country: params.customerAddress.country,
      phone: params.customerAddress.phone || undefined,
    },
    to_address: {
      name: returnAddress.name,
      street1: returnAddress.street1,
      street2: returnAddress.street2 || undefined,
      city: returnAddress.city,
      state: returnAddress.state,
      zip: returnAddress.zip,
      country: returnAddress.country,
      phone: returnAddress.phone || undefined,
    },
    parcel: {
      length: defaultParcel.length,
      width: defaultParcel.width,
      height: defaultParcel.height,
      weight: totalWeightOz,
    },
    options: { is_return: true },
  });

  // Get cheapest rate — prefer USPS GroundAdvantage/Priority, fall back to overall cheapest
  let rate;
  try {
    rate = shipment.lowestRate(["USPS"], ["GroundAdvantage", "Priority"]);
  } catch {
    // No USPS rate found, get overall cheapest
    rate = shipment.lowestRate();
  }

  const costCents = Math.round(parseFloat(rate.rate) * 100);

  return {
    shipmentId: shipment.id,
    rate: {
      id: rate.id,
      carrier: rate.carrier,
      service: rate.service,
      costCents,
      estimatedDays: rate.delivery_days || null,
    },
  };
}

/**
 * Phase 2: Buy the return label on an existing shipment.
 * Called during initiate_return step after customer accepts.
 */
export async function purchaseReturnLabel(
  workspaceId: string,
  shipmentId: string,
  rateId?: string,
): Promise<PurchasedLabel> {
  const client = await getEasyPostClient(workspaceId);

  // Retrieve the shipment to get its rates
  const shipment = await client.Shipment.retrieve(shipmentId);

  // Find the specific rate or use cheapest
  let rateToUse;
  if (rateId) {
    rateToUse = shipment.rates.find((r: { id: string }) => r.id === rateId);
    if (!rateToUse) {
      throw new Error(`Rate ${rateId} not found on shipment ${shipmentId}`);
    }
  } else {
    try {
      rateToUse = shipment.lowestRate(["USPS"], ["GroundAdvantage", "Priority"]);
    } catch {
      rateToUse = shipment.lowestRate();
    }
  }

  // Buy the label
  const purchased = await client.Shipment.buy(shipmentId, rateToUse);

  const costCents = Math.round(parseFloat(purchased.selected_rate.rate) * 100);

  return {
    trackingNumber: purchased.tracking_code,
    labelUrl: purchased.postage_label?.label_url || "",
    carrier: purchased.selected_rate.carrier,
    costCents,
  };
}

/**
 * Get tracking status for a shipment from EasyPost (by shipment ID).
 */
export async function getTrackingStatus(
  workspaceId: string,
  shipmentId: string,
): Promise<TrackingStatus> {
  const client = await getEasyPostClient(workspaceId);

  const shipment = await client.Shipment.retrieve(shipmentId);
  const tracker = shipment.tracker;

  if (!tracker) {
    return { status: "unknown", estimatedDelivery: null, events: [] };
  }

  return {
    status: tracker.status,
    estimatedDelivery: tracker.est_delivery_date || null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: (tracker.tracking_details || []).map((detail: any) => ({
      status: detail.status as string,
      message: detail.message as string,
      datetime: detail.datetime as string,
      city: (detail.tracking_location?.city as string) || undefined,
      state: (detail.tracking_location?.state as string) || undefined,
      zip: (detail.tracking_location?.zip as string) || undefined,
    })),
  };
}

// ── Address Verification ──

export interface AddressVerificationResult {
  valid: boolean;
  address: {
    street1: string;
    street2: string | null;
    city: string;
    state: string;
    zip: string;
    country: string;
    phone: string | null;
  };
  suggestedAddress: {
    street1: string;
    street2: string | null;
    city: string;
    state: string;
    zip: string;
    country: string;
  } | null;
  errors: string[];
}

/**
 * Verify a shipping address via EasyPost.
 * Returns the verified/corrected address or validation errors.
 */
export async function verifyAddress(
  workspaceId: string,
  address: {
    name?: string;
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
    phone?: string;
  },
): Promise<AddressVerificationResult> {
  const client = await getEasyPostClient(workspaceId);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verified = await (client.Address as any).createAndVerify({
      street1: address.street1,
      street2: address.street2 || undefined,
      city: address.city,
      state: address.state,
      zip: address.zip,
      country: address.country,
      name: address.name || undefined,
      phone: address.phone || undefined,
    });

    return {
      valid: true,
      address: {
        street1: verified.street1 || address.street1,
        street2: verified.street2 || null,
        city: verified.city || address.city,
        state: verified.state || address.state,
        zip: verified.zip || address.zip,
        country: verified.country || address.country,
        phone: verified.phone || address.phone || null,
      },
      suggestedAddress: null,
      errors: [],
    };
  } catch (err: unknown) {
    // EasyPost returns errors with suggested corrections
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const easypostErr = err as any;
    const errors: string[] = [];

    if (easypostErr?.errors) {
      for (const e of easypostErr.errors) {
        errors.push(e.message || String(e));
      }
    } else if (easypostErr?.message) {
      errors.push(easypostErr.message);
    }

    // Check if there's a suggested address in the error
    const suggested = easypostErr?.address;
    return {
      valid: false,
      address: {
        street1: address.street1,
        street2: address.street2 || null,
        city: address.city,
        state: address.state,
        zip: address.zip,
        country: address.country,
        phone: address.phone || null,
      },
      suggestedAddress: suggested ? {
        street1: suggested.street1 || address.street1,
        street2: suggested.street2 || null,
        city: suggested.city || address.city,
        state: suggested.state || address.state,
        zip: suggested.zip || address.zip,
        country: suggested.country || address.country,
      } : null,
      errors,
    };
  }
}

/**
 * Look up tracking by tracking number + carrier via EasyPost Tracker API.
 * This costs money per lookup — only call when Shopify data is insufficient.
 * Returns normalized status + full event history with locations.
 */
export async function lookupTracking(
  workspaceId: string,
  trackingNumber: string,
  carrier?: string,
): Promise<TrackingStatus> {
  const client = await getEasyPostClient(workspaceId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = { tracking_code: trackingNumber };
  if (carrier) params.carrier = carrier;

  const tracker = await client.Tracker.create(params);

  return {
    status: tracker.status || "unknown",
    estimatedDelivery: tracker.est_delivery_date || null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: (tracker.tracking_details || []).map((detail: any) => ({
      status: detail.status as string,
      message: detail.message as string,
      datetime: detail.datetime as string,
      city: (detail.tracking_location?.city as string) || undefined,
      state: (detail.tracking_location?.state as string) || undefined,
      zip: (detail.tracking_location?.zip as string) || undefined,
    })),
  };
}
