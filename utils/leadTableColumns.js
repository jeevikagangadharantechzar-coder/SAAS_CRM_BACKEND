// Columns an Admin may show/hide/reorder on the Leads table. The checkbox,
// Lead Name and Actions columns are always rendered by the frontend and are
// deliberately NOT in this list, so they can never be hidden or moved.
//
// Order here = default order; `visible` = shown when nothing is saved yet
// (matches the table's original fixed layout). The frontend owns the labels
// and cell rendering for each key — keep the two lists in sync.
export const LEAD_TABLE_COLUMNS = [
  { key: "phoneNumber",          visible: true  },
  { key: "companyName",          visible: true  },
  { key: "country",              visible: true  },
  { key: "source",               visible: true  },
  { key: "status",               visible: true  },
  { key: "assignTo",             visible: true  },
  { key: "createdAt",            visible: true  },
  { key: "followUpDate",         visible: true  },
  { key: "history",              visible: true  },
  { key: "email",                visible: false },
  { key: "alternatePhoneNumber", visible: false },
  { key: "alternateEmail",       visible: false },
  { key: "clientType",           visible: false },
  { key: "industry",             visible: false },
  { key: "requirement",          visible: false },
  { key: "NumberOfEmployees",    visible: false },
  { key: "address",              visible: false },
  { key: "city",                 visible: false },
  { key: "state",                visible: false },
  { key: "pincode",              visible: false },
];

const ALLOWED_KEYS = new Set(LEAD_TABLE_COLUMNS.map((c) => c.key));

export const defaultLeadTableColumns = () =>
  LEAD_TABLE_COLUMNS.map(({ key, visible }) => ({ key, visible }));

// Keeps the saved order, drops unknown/duplicate keys, and appends any column
// added to the list after the Admin last saved (hidden, so the table doesn't
// change on its own).
export const normalizeLeadTableColumns = (saved) => {
  if (!Array.isArray(saved) || saved.length === 0) return defaultLeadTableColumns();
  const seen = new Set();
  const result = [];
  for (const col of saved) {
    const key = col?.key;
    if (!ALLOWED_KEYS.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push({ key, visible: Boolean(col.visible) });
  }
  for (const { key } of LEAD_TABLE_COLUMNS) {
    if (!seen.has(key)) result.push({ key, visible: false });
  }
  return result;
};

// Returns an error message, or null when the payload is valid.
export const validateLeadTableColumns = (columns) => {
  if (!Array.isArray(columns)) return "columns must be an array";
  const seen = new Set();
  for (const col of columns) {
    if (!col || typeof col.key !== "string") return "Each column needs a key";
    if (!ALLOWED_KEYS.has(col.key)) return `Unknown column: ${col.key}`;
    if (seen.has(col.key)) return `Duplicate column: ${col.key}`;
    if (col.visible !== undefined && typeof col.visible !== "boolean") return `visible must be true or false (${col.key})`;
    seen.add(col.key);
  }
  return null;
};
