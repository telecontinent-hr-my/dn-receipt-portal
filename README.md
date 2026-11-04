# DN Receipt Portal

Telecontinent Sdn Bhd · Human Resources & Administration

This portal gives DN staff one place to submit their claim receipts. HR then matches the receipts to the DN approved workbook and checks them.

| Page | Who uses it | How they sign in |
|---|---|---|
| https://dn-receipt-portal.hairul-izwan.workers.dev/ (staff page) | DN staff | No login. Staff enter their TC ID; only active staff on the list are accepted. Max 30 uploads per hour per network. Staff cannot see any stored receipt. |
| https://dn-receipt-hr.hairul-izwan.workers.dev/ (HR page) | HR team | Cloudflare Access email code. Only the emails in the Access policy and in `HR_EMAILS` get in. |

Two workers run from this one repo and share one database (D1 `dn-receipts`) and one file bucket (R2 `dn-receipts`): `dn-receipt-portal` (deploy command `npx wrangler deploy`) and `dn-receipt-hr` (deploy command `npx wrangler deploy --env hr`). Every push to `main` redeploys both. Each receipt gets a reference number (DNR-XXXXXXXX) that staff see after upload and HR sees in the Receipts tab.

To add or remove an HR user: change both the Access policy "DN Receipt HR users" (Zero Trust → Access controls → Policies) and `HR_EMAILS` under `[env.hr.vars]` in `wrangler.toml`.

---

## How it works (from Nov 2026)

1. **HR uploads the DN approved workbook** (HR page → Upload DN approvals). Tick the month sheets to save. Each staff + category with an amount becomes one claim line. Uploading the same month again updates the amounts; receipts already uploaded are kept.
2. **Staff enter their TC ID** on the staff page. They see their DN-approved claims for the latest 3 months and upload receipts for each claim (photos or PDFs, many per claim).
3. **The system reads each receipt** and sets the status:
   - PDFs with text (Touch 'n Go / toll statements, parking statements): the amount is taken from the text. For toll statements only the toll lines count (ANPR "Total Amount" and PayDirect / RFID lines).
   - Photos and scanned PDFs: Cloudflare Workers AI (`@cf/mistralai/mistral-small-3.1-24b-instruct`, free daily allowance of about 200 images a day) reads the amount.
   - The AI also checks every file: is it a receipt, does it fit the category, and for Medical / Optical / Dental / Swab test, is the patient the staff or a child of the staff (spouse is not covered).
   - The same file can never be used twice (any claim, any staff).
   - Annual entitlement (HR page → Entitlements): when the DN-approved amount for the year goes above the limit, the claim goes to HR.
4. **Status**: *Cleared* (receipts cover the DN amount and nothing is flagged) · *Receipts short* (staff must add more) · *HR check* (with the reason) · *Not submitted*. HR can Clear or Reject any line; a rejected line shows the reason to the staff.
5. **Export Excel** on the Claims tab gives a "For iPayroll (cleared)" sheet, a "Needs HR" sheet and all lines.

If the AI daily allowance runs out, photos read as "amount could not be read" and go to HR check. Nothing is cleared without a reading.

---

## What the portal checks

For the claim month you choose, each staff member and claim category gets one line. The line compares the **DN approved amount** with the **receipts received**.

| Result | Meaning | Action |
|---|---|---|
| Supported | Receipts are equal to or more than the DN approved amount | OK. Pay up to the DN approved amount only. |
| Supported in group | DN put the amount under a nearby column (e.g. parking inside Toll), but the group total is covered | OK. Check the note. |
| Receipts short | Receipts are less than the DN approved amount | Ask for the missing receipt, or pay up to the receipts |
| No receipt | DN approved an amount but no receipt was received | Ask the staff to submit |
| No DN approval | Receipt was received but DN did not approve it this month | Do not pay this month. The portal shows any approval in other month sheets. |
| Staff not on list | DN workbook has a staff member who is not on the portal staff list | Add them to the staff list |

The portal also flags:
- The **same file** sent twice. It is blocked at upload.
- The same staff, receipt date and amount appearing in more than one record (a possible duplicate).
- The same receipt number used more than once.
- A receipt dated after the claim month.
- A receipt dated more than N months before the claim month. You set N on the HR page (default 6).
- Errors in the DN workbook (#REF!, text in amount cells, unknown columns).

Groups used for the group check: Medical (Medical, Optical/Dental) · Car (Road Tax, Insurance, Maintenance) · Travel (Parking Office, Mileage, Parking, Toll, Accommodation, Transportation, Meal) · Phone & Internet (Streamyx, Handphone).

**Not included:** reading the amount from the receipt image (no OCR; staff key in the amount), annual entitlement limits, and iPayroll entry.

---

## One-time setup (about 30 minutes)

You need the Cloudflare account that already runs HR TMS Helper, and the GitHub account `hairulfirdee-eng`.

### 1. Put the code on GitHub
1. In GitHub, create a new **private** repository named `dn-receipt-portal`.
2. Upload every file in this folder **except** `node_modules`, `.wrangler`, `.dev.vars` and `test/out`.

### 2. Create the database (D1)
1. Cloudflare dashboard → **Storage & Databases → D1** → **Create database** → name `dn-receipts`.
2. Copy the **Database ID** into `wrangler.toml` (replace `REPLACE_WITH_D1_DATABASE_ID`). Commit the change on GitHub.
3. Open the database → **Console** → paste the whole of `schema.sql` → **Execute**.

### 3. Create the file storage (R2)
1. Cloudflare dashboard → **R2 Object Storage**. Cloudflare asks you to add a card the first time. The free tier is 10 GB of storage, and you are not charged while usage stays inside it.
2. **Create bucket** → name `dn-receipts` → keep the default settings. Do **not** turn on public access.

### 4. Deploy the worker
1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → choose `dn-receipt-portal`.
2. Leave the deploy command as `npx wrangler deploy` → **Deploy**.
3. Note the address, e.g. `https://dn-receipt-portal.<your-name>.workers.dev`.

### 5. Session secret
Nothing to do. The worker creates its own random signing key the first time it runs and keeps it in the database (table `app_settings`). To replace it, delete that row; all staff will need to sign in again.

### 6. Protect the HR page with Cloudflare Access
1. **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Name: `DN Receipt Check (HR)`. Domain: the worker address from step 4, **path** `hr.html`.
3. Policy: reuse your existing **HR Team** policy.
4. Save. Open the application → **Overview** → copy the **Application Audience (AUD) Tag**.
5. In `wrangler.toml`, set:
   - `ACCESS_AUD` = the AUD tag
   - `ACCESS_TEAM_DOMAIN` = your team domain, e.g. `telecontinent.cloudflareaccess.com` (Zero Trust → Settings → Custom pages shows it)
   - `HR_EMAILS` = HR users who may open the HR page, separated by commas
6. Commit on GitHub. Cloudflare redeploys automatically.

Only emails listed in `HR_EMAILS` and allowed by Access get HR rights.

### 7. Load the staff list and issue PINs
1. Open `https://<worker address>/hr.html` → **Staff list**.
2. Upload `DN staff list - starter.xlsx`. It already has 52 DN staff with TC ID and DN person no., taken from the Oct-26 DN sheet and the iPayroll Oct 2026 report. First fill in the TC ID for the 2 staff marked in the Note column, and confirm the 1 partial name match.
3. Click **Issue PINs to staff without PIN**. An Excel file with each staff member's PIN downloads.
4. Send each staff member **only their own** PIN, plus the link `https://<worker address>/`. Delete the PIN file after sending.

To add a new staff member later, upload a file with that staff row, then click **Issue PIN** next to the name.

---

## Monthly use

1. Staff submit receipts all month at `/`. One receipt per submission.
2. Receipts sent to HR by WhatsApp or email: use **Add for staff** on the HR page. The record shows "HR on behalf" and who added it.
3. When the DN approved workbook arrives: **Match & validate** → upload the workbook → check the month sheet → **Match receipts**.
4. Work through **Items to act on or check**. Click an amount to open that receipt.
5. In **Receipts**, **Accept** the good receipts and **Reject** the bad ones with a reason. Staff see the reason on their page.
6. **Export Excel** to keep the result. It has four sheets: Summary, To act on, All lines and Receipts.

Rules built in:
- Nothing is deleted. Rejected and withdrawn receipts stay on record.
- Every action (submit, withdraw, accept, reject, staff upload, PIN reset, login) is in the **Log** tab.
- Staff can only see and open their own receipts.
- 5 wrong PIN attempts lock the account for 15 minutes. HR can reset a PIN at any time, which signs the staff member out.
- Files up to 10 MB: JPG, PNG, HEIC or PDF. Large phone photos are shrunk before upload.

---

## Local testing (for changes)

```
npm install
npx wrangler d1 execute dn-receipts --local --file=schema.sql
npx wrangler dev --local
```

`.dev.vars` (not uploaded to GitHub) holds `DEV_MODE=1`, `DEV_USER_EMAIL=<an HR email>` and `SESSION_SECRET=<random>`. **Never set DEV_MODE in Cloudflare.**

`node test/match.test.js <workbook.xlsx>` runs the matching rules on a DN workbook, and `node test/e2e.js <workbook.xlsx>` runs the full browser test. Both need a test staff list: `test/staff.json`, plus `test/staff.xlsx` for the browser test. These are left out of the package because they hold staff names.
