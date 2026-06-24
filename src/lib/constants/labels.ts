/**
 * Human-readable labels + badge color hints for the Prisma enums.
 * Keeps UI text out of the database and centralizes display formatting.
 */

export const LEAD_STATUS_LABELS: Record<string, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  INTERESTED: "Interested",
  FOLLOW_UP: "Follow Up",
  QUOTATION_SENT: "Quotation Sent",
  NEGOTIATION: "Negotiation",
  WON: "Won",
  LOST: "Lost",
};

export const LEAD_SOURCE_LABELS: Record<string, string> = {
  WEBSITE: "Website",
  META_ADS: "Meta Ads",
  GOOGLE_ADS: "Google Ads",
  TRADE_SHOW: "Trade Show",
  REFERRAL: "Referral",
  DISTRIBUTOR: "Distributor",
  DIRECT_CALL: "Direct Call",
  WHATSAPP: "WhatsApp",
  ORGANIC_SEARCH: "Organic Search",
  GOVERNMENT_TENDER: "Government Tender",
  OTHER: "Other",
};

export const CUSTOMER_TYPE_LABELS: Record<string, string> = {
  B2C_FARMER: "Farmer",
  B2B_RETAILER: "Retailer",
  B2B_DEALER: "Dealer",
  B2B_DISTRIBUTOR: "Distributor",
  AGRI_INPUT_SHOP: "Agri Input Shop",
  FPO_COOPERATIVE: "FPO / Cooperative",
  NGO: "NGO",
  GOVERNMENT: "Government",
  CORPORATE_FARM: "Corporate Farm",
  PLANTATION: "Plantation",
};

export const PIPELINE_STAGE_LABELS: Record<string, string> = {
  NEW_LEAD: "New Lead",
  FIRST_CONTACT: "First Contact",
  REQUIREMENT_GATHERING: "Requirement Gathering",
  PRODUCT_DISCUSSION: "Product Discussion",
  SAMPLE_SENT: "Sample Sent",
  QUOTATION_SENT: "Quotation Sent",
  NEGOTIATION: "Negotiation",
  ORDER_RECEIVED: "Order Received",
  WON: "Won",
  LOST: "Lost",
};

/** Ordered pipeline stages for the Kanban board (left to right). */
export const PIPELINE_STAGE_ORDER = [
  "NEW_LEAD",
  "FIRST_CONTACT",
  "REQUIREMENT_GATHERING",
  "PRODUCT_DISCUSSION",
  "SAMPLE_SENT",
  "QUOTATION_SENT",
  "NEGOTIATION",
  "ORDER_RECEIVED",
  "WON",
  "LOST",
] as const;

/**
 * Pipeline stage -> Lead.status sync mapping. Moving a Kanban card derives the
 * lead's lifecycle status from this table (see updateLeadStage server action).
 */
export const STAGE_TO_STATUS: Record<string, string> = {
  NEW_LEAD: "NEW",
  FIRST_CONTACT: "CONTACTED",
  REQUIREMENT_GATHERING: "CONTACTED",
  PRODUCT_DISCUSSION: "INTERESTED",
  SAMPLE_SENT: "INTERESTED",
  QUOTATION_SENT: "QUOTATION_SENT",
  NEGOTIATION: "NEGOTIATION",
  ORDER_RECEIVED: "NEGOTIATION",
  WON: "WON",
  LOST: "LOST",
};

export const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  NOTE: "Note",
  STATUS_CHANGE: "Status Change",
  STAGE_CHANGE: "Stage Change",
  CALL_LOGGED: "Call Logged",
  FOLLOWUP_LOGGED: "Follow-up Logged",
  FOLLOWUP_COMPLETED: "Follow-up Completed",
  TASK_CREATED: "Task Created",
  QUOTATION_CREATED: "Quotation Created",
  QUOTATION_SENT: "Quotation Sent",
  LEAD_ASSIGNED: "Lead Assigned",
  LEAD_CONVERTED: "Lead Converted",
  FILE_ATTACHED: "File Attached",
  EMAIL_SENT: "Email Sent",
  WHATSAPP_SENT: "WhatsApp Sent",
};

export const CALL_OUTCOME_LABELS: Record<string, string> = {
  CONNECTED: "Connected",
  NOT_REACHABLE: "Not Reachable",
  BUSY: "Busy",
  INTERESTED: "Interested",
  FOLLOW_UP_REQUIRED: "Follow Up Required",
  QUOTATION_REQUESTED: "Quotation Requested",
  CONVERTED: "Converted",
  WRONG_NUMBER: "Wrong Number",
};

export const PRODUCT_CATEGORY_LABELS: Record<string, string> = {
  VERMICOMPOST: "Vermicompost",
  PROM: "PROM",
  HUMIC_ACID: "Humic Acid",
  ORGANIC_FERTILIZER: "Organic Fertilizer",
  MICRONUTRIENT: "Micronutrient",
  SOIL_CONDITIONER: "Soil Conditioner",
  BIO_FERTILIZER: "Bio Fertilizer",
  CROP_NUTRITION: "Crop Nutrition",
};

export const QUOTATION_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  CONFIRMED: "Confirmed",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  PARTIAL: "Partial",
  PAID: "Paid",
};

export const CALL_DIRECTION_LABELS: Record<string, string> = {
  INBOUND: "Inbound",
  OUTBOUND: "Outbound",
};

export const FOLLOWUP_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  COMPLETED: "Completed",
  RESCHEDULED: "Rescheduled",
  CANCELLED: "Cancelled",
};

export const TASK_STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

export const TASK_PRIORITY_LABELS: Record<string, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
};

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super Admin",
  SALES_MANAGER: "Sales Manager",
  SALES_EXECUTIVE: "Sales Executive",
  DISTRIBUTOR_MANAGER: "Distributor Manager",
  ACCOUNTS_TEAM: "Accounts Team",
};

export function inr(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
}
