// Keeps a client's contact details identical everywhere they are stored.
//
// The Deal is the source of truth. Invoices and Proposals keep their own copy
// (autofilled when they are created), so whenever the details are changed on a
// Deal, an Invoice or a Proposal, this pushes the change to the Deal and to every
// Invoice and Proposal linked to that Deal.
import { getTenantModels } from "../models/tenant/index.js";
import DealLegacy     from "../models/deals.model.js";
import InvoiceLegacy  from "../models/invoice.model.js";
import ProposalLegacy from "../models/proposal.model.js";

const getModels = (req) =>
  req.tenantDB
    ? getTenantModels(req.tenantDB)
    : { Deal: DealLegacy, Invoice: InvoiceLegacy, Proposal: ProposalLegacy };

// Deal fields that are mirrored onto invoices / proposals
const DEAL_FIELDS = ["email", "phoneNumber", "companyName", "dealName", "address", "state"];

const norm = (v) => String(v ?? "").trim();
const splitEmails = (s) => norm(s).split(",").map((e) => e.trim()).filter(Boolean);

/**
 * @param req      Express request (for tenant DB)
 * @param dealId   Deal the details belong to
 * @param changes  New values keyed by Deal field name (email, phoneNumber, companyName, dealName, address, state)
 * @param opts.oldDeal     Deal as it was before the change (when the Deal was already saved by the caller)
 * @param opts.dealSaved   true when the caller already wrote the Deal itself
 * @param opts.allowBlank  true to also sync cleared values (only the Deal form may clear fields)
 */
export async function propagateClientDetails(req, dealId, changes, { oldDeal = null, dealSaved = false, allowBlank = false } = {}) {
  if (!dealId || !changes) return;
  const { Deal, Invoice, Proposal } = getModels(req);

  const before = oldDeal || (await Deal.findById(dealId).lean());
  if (!before) return;

  // Keep only fields that are really different from what the Deal had
  const diff = {};
  for (const f of DEAL_FIELDS) {
    if (changes[f] === undefined) continue;
    const next = norm(changes[f]);
    if (!next && !allowBlank) continue;
    // An invoice shows the deal name as the client name when there is no company
    // name — don't turn that back into a company name on the Deal.
    if (f === "companyName" && !allowBlank && !norm(before.companyName) && next === norm(before.dealName)) continue;
    if (next !== norm(before[f])) diff[f] = next;
  }
  if (!Object.keys(diff).length) return;

  // 1. Deal
  if (!dealSaved) await Deal.updateOne({ _id: dealId }, { $set: diff });

  // 2. Invoices of this deal
  const invoiceSet = {};
  if (diff.email !== undefined)       invoiceSet.clientEmail    = diff.email;
  if (diff.phoneNumber !== undefined) invoiceSet.clientPhone    = diff.phoneNumber;
  if (diff.address !== undefined)     invoiceSet.billingAddress = diff.address;
  if (diff.state !== undefined)       invoiceSet.clientState    = diff.state;
  if (diff.companyName !== undefined || diff.dealName !== undefined) {
    const company = diff.companyName ?? norm(before.companyName);
    const name = diff.dealName ?? norm(before.dealName);
    invoiceSet.clientName = company || name;
  }
  if (Object.keys(invoiceSet).length) {
    await Invoice.updateMany({ "items.deal": dealId }, { $set: invoiceSet });
  }

  // 3. Proposals of this deal
  const proposalSet = {};
  if (diff.companyName !== undefined) proposalSet.companyName = diff.companyName;
  if (diff.dealName) proposalSet.dealTitle = diff.dealName;
  if (Object.keys(proposalSet).length) {
    await Proposal.updateMany({ deal: dealId }, { $set: proposalSet });
  }
  // Proposal email is a recipient list: swap the old client email for the new
  // one (or the first recipient if the old one isn't there). Never blank it — it's required.
  if (diff.email) {
    const oldEmail = norm(before.email).toLowerCase();
    const proposals = await Proposal.find({ deal: dealId }).select("email").lean();
    const ops = [];
    for (const p of proposals) {
      const list = splitEmails(p.email);
      const idx = oldEmail ? list.findIndex((e) => e.toLowerCase() === oldEmail) : -1;
      if (idx >= 0) list[idx] = diff.email;
      else if (list.length) list[0] = diff.email;
      else list.push(diff.email);
      const next = [...new Set(list)].join(",");
      if (next !== p.email) ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { email: next } } } });
    }
    if (ops.length) await Proposal.bulkWrite(ops);
  }
}

// Map an invoice's client fields to Deal field names
export const invoiceToDealFields = (src) => ({
  email:       src.clientEmail,
  phoneNumber: src.clientPhone,
  companyName: src.clientName,
  address:     src.billingAddress,
  state:       src.clientState,
});

// Unique deal ids referenced by an invoice's items
export const invoiceDealIds = (items = []) =>
  [...new Set(items.map((i) => String(i?.deal?._id || i?.deal || "")).filter(Boolean))];

export const firstEmail = (s) => splitEmails(s)[0];
