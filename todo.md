# AtoZ Money Manager — Feature and Quality Tracker

## Completed application features

| Area | Status | Notes |
|---|---|---|
| Authentication and authorization | Complete | Managed OAuth, administrator role, least-privilege user permissions, protected routes, and server-side enforcement. |
| Customer management | Complete | Create, edit, search, detail, meter information, image upload, summaries, and safe deletion. |
| Billing and payments | Complete | Duplicate-safe monthly bills, automatic readings and carry-forward balances, status synchronization, partial/full payments, and downstream ledger recalculation. |
| WAPDA ledger and profit | Complete | Unique monthly records, calculated units and expense, customer analysis, and actual-receipt profit reporting. |
| Reporting and export | Complete | Dashboard charts, history, reports, professional bill, PDF, print, CSV, WhatsApp, and email. |
| Company and user settings | Complete | Company details, logos, QR codes, bank information, roles, and granular permissions. |
| Responsive interface | Complete | Desktop sidebar, mobile bottom navigation, touch-friendly controls, empty/loading states, and print styling. |

## Bulk Import (JSON)

| Requirement | Status | Behavior |
|---|---|---|
| Dashboard control | Complete | `Bulk Import (JSON)` appears immediately after `CSV Export` for administrators. |
| Supported JSON roots | Complete | Accepts either a direct customer array `[...]` or an object with `customers`, `billing_history`, and `wapda_records`; camel-case and existing-table aliases are also accepted. |
| Stringified JSON normalization | Complete | Valid JSON strings are automatically parsed at the file root, collection level, and individual row level; mixed stringified and direct object rows are accepted. |
| Customer matching | Complete | Upsert by canonical unique `sNo`; legacy `serialNumber` remains synchronized for compatibility and imported source IDs are mapped to persisted customer IDs. |
| Billing matching | Complete | Upsert by customer + year + month; customer reference may use source ID, canonical sNo, legacy serial number, or unique name. |
| WAPDA matching | Complete | Upsert by year + month. |
| Financial integrity | Complete | Units, charges, payable, outstanding, statuses, WAPDA totals, and all carry-forward balances are recalculated server-side. |
| Safety | Complete | Administrator-only, validated, maximum 10,000 rows per table, and executed in one database transaction with rollback on any error. |
| Verification | Complete | Authorization, rollback, upsert, relation mapping, string normalization, 21 automated tests, type checks, production build, and desktop/mobile visual verification passed. |

## Canonical customer sNo audit

| Requirement | Status | Behavior |
|---|---|---|
| Strict serial assignment | Complete | Added a unique `customers.sNo` field and populated the live database in ascending legacy-serial order without breaking internal bill foreign keys. Existing `id` relations remain intact; `sNo` is the app-level customer identifier. |
| Live data audit | Complete | Verified 22 customers with unique, sequential values `1` through `22`; no customer records were deleted. |
| sNo-first meter import | Complete | Meter-reading JSON accepts minimal `{ "sNo": 1, "currentReading": 21.393 }` rows, stringified rows, and optional `nameTag` metadata. If sNo is present, matching is direct and no new customer is created. |
| Safe name fallback | Complete | Name normalization remains available only when sNo is absent; ambiguous close matches require explicit administrator approval. |
| Global display and ordering | Complete | Dashboard, customers, bills, history, ledger, reports, print bills, and mobile views show sNo and sort records numerically. |
| Verification | Complete | 29 tests passed, TypeScript passed, production build passed, live sNo audit passed, and desktop/mobile screenshots confirmed the UI. |

## SolarBill native export seed

The uploaded `SolarBill_ATOZ_Solar_System.json` declares totals of 22 customers, 56 bills, and 2 WAPDA records, but the actual uploaded file is only 3,706 bytes and contains 1 customer, 2 nested bills, and 1 WAPDA record. All records actually present were imported transactionally. The importer now supports the native nested structure, month names, account IDs, historical photos, invoice numbers, and exported financial totals. The database and UI were verified with the available data; the missing 21 customers, 54 bills, and 1 WAPDA record cannot be seeded until a complete export is uploaded.

## Expected JSON shape

A customer-only file may be a direct array:

```json
[
  {
    "name": "Customer Name",
    "sNo": 1,
    "serialNumber": 1,
    "unitPrice": 65,
    "meterNumber": "M-001"
  }
]
```

Items may also be stringified JSON objects, including a mix of strings and direct objects:

```json
[
  "{\"name\":\"Stringified Customer\",\"sNo\":2}",
  { "name": "Direct Customer", "sNo": 3 }
]
```

For customers together with billing or WAPDA data, use the object shape:

```json
{
  "customers": [
    {
      "id": 101,
      "name": "Customer Name",
      "sNo": 1,
      "serialNumber": 1,
      "unitPrice": 45,
      "meterNumber": "M-001"
    }
  ],
  "billing_history": [
    {
      "customerId": 101,
      "month": 9,
      "year": 2026,
      "previousReading": 1000,
      "currentReading": 1100,
      "unitPrice": 65,
      "receivedAmount": 2000,
      "issuedDate": "2026-09-01",
      "dueDate": "2026-09-10"
    }
  ],
  "wapda_records": [
    {
      "month": 9,
      "year": 2026,
      "previousReading": 5000,
      "currentReading": 5200,
      "ratePerUnit": 65
    }
  ]
}
```

## Bulk import matching refinement — 2026-09-19

The meter-reading import now resolves a valid `sNo` directly first and ignores name spelling whenever that serial exists. When sNo is missing or does not resolve, normalized names use case/space/punctuation cleanup plus token containment, compact-name comparison, and a lower 0.50 candidate threshold. Ambiguous candidates remain approval-gated; unmatched rows retain their exact imported name. Added regression coverage for ARYAN, AMINULLAH, HAFEEZ, MOBEN KI, NAIMAT, NASIR, ARBAZ KHAN, and KHUSHDIL-style variants. The full suite passes with 30 tests.

## WAPDA bulk-array and 65 PKR rate update — 2026-09-20

| Requirement | Status | Behavior |
|---|---|---|
| Bulk array import | Complete | Meter-reading JSON accepts a top-level array of multiple customer records, including stringified rows, and processes the complete batch through the existing import flow. Daily WAPDA JSON also accepts an array and aggregates only the supplied rows for the selected date. |
| Flexible numeric fields | Complete | `previousReading`, `currentReading`, `unitsConsumed`, and `totalAmount` accept numeric values or numeric strings. Missing `previousReading` defaults to `0`; invalid, NaN, negative, or descending readings are reported safely. |
| Automatic amount calculation | Complete | Meter-reading imports calculate `totalAmount = Math.round(unitsConsumed * 65)` and use normalized units/current readings when creating or updating the month bill. Explicit historical/customer rates remain honored when supplied. |
| Default rate | Complete | Application defaults, form defaults, importer defaults, WAPDA fallbacks, schema defaults, and database column defaults now use 65 PKR. Existing stored rates and historical records were not rewritten. |
| Verification | Complete | 32 automated tests passed, TypeScript passed, production build passed, live health passed, and desktop/mobile ledger screenshots confirmed the 65 PKR default and responsive import UI. |

## Customer slots and WAPDA monthly board — 2026-09-21

- Added **#8 Arbaz Khan** and **#21 Sarbaz Khan** in the two vacant canonical sNo slots; existing #20 Rafi ullah and all existing histories remain untouched.
- Fixed new-customer creation so leaving sNo blank assigns the first vacant canonical sNo and an independently available legacy serial number, avoiding unique-key collisions.
- WAPDA Ledger now presents actual imported daily records for the selected month with a selected-day result, last-7-day result, last-15-day result, and complete-month result. Missing dates are never generated or included as fake readings.
- Verification: **33 tests passed**, TypeScript passed, production build passed, live health passed, and desktop/mobile screenshots confirmed #8/#21 and the summary cards.

## Customer Meter Details simplification — 2026-09-24

- Removed the **Daily Combined Result** section completely.
- Added a separate Customer Meter Details workflow with selected month/date, customer selector, previous/current readings, manual add/edit, JSON file import, JSON paste, preview, and save/update.
- Customer daily records remain separate from WAPDA records and continue using the existing monthly bill recalculation logic.
- Verification: **41 tests passed**, TypeScript passed, production build passed, and the removed section no longer exists in client source.

## Dynamic customer date and range summary update — 2026-09-24

- Manual customer entry now supports any selected date and updates that customer’s matching calendar cell immediately after save/refetch.
- If a previous reading is not entered, the backend automatically uses the customer’s saved reading from the previous calendar date; consumption is always calculated as `Current Reading - Previous Reading` and invalid descending values are rejected.
- Added an all-customer one-click summary for 7 days, 10 days, 14 days, complete month, and arbitrary custom day ranges, showing customers with data, imported days, total units, and total amount.
- Verification: **42 tests passed**, TypeScript passed, production build passed, live health passed, and desktop/mobile screenshots confirmed the controls.

## Per-customer card reading controls — 2026-09-24

Added only the requested fields inside every customer card header: date selector, Previous reading, Current reading, and Save. The save action uses the existing customer daily upsert and refreshes that customer’s matching calendar date. Existing designs, colors, card styling, data, history, and readings were preserved. Verification: 42 tests passed, TypeScript passed, production build passed, live health passed, and desktop/mobile screenshots confirmed the controls.
