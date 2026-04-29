# ShipmentTracker

ShipmentTracker is a React + Vite web app for logistics teams to upload shipment CSV files, ask natural-language questions, and generate delay insights as charts/tables with PDF export.

## What the App Does

- Lets managers sign up/login and analyze shipment data directly in the browser
- Uploads and validates CSV shipment files
- Accepts plain-English questions about delays and trends
- Generates chart and table insights from uploaded data
- Exports insight reports to PDF
- Saves per-user analysis history in browser local storage

## How the App Works

1. User authenticates with a simple signup/login form (stored in browser storage).
2. User uploads a CSV; the app parses and validates rows client-side.
3. The app normalizes columns and derives helper values (dates, delay minutes, delayed status).
4. It interprets the typed question to detect:
   - analysis dimension (route, carrier, destination, origin)
   - metric (delay count, average delay, total delay minutes, shipment count)
   - time window (last month, this month, last N days, specific month)
5. Data is grouped, sorted, and rendered as chart/table output with a narrative.
6. User can export the current insight to PDF and reopen previous history items later.

## Tech Stack and Tools

- **Framework/UI:** React
- **Bundler/Dev Server:** Vite
- **Language:** JavaScript (ES modules)
- **CSV Parsing:** PapaParse
- **Charts:** Recharts
- **PDF Export:** jsPDF + jspdf-autotable
- **Chart Capture for PDF:** html2canvas
- **Linting:** ESLint
- **Storage:** Browser localStorage
- **Package Manager:** npm

## Prerequisites

- Node.js `20+` (recommended for Vite 8 compatibility)
- npm `10+`

Check installed versions:

```bash
node -v
npm -v
```

## Install Dependencies

From the project root:

```bash
npm install
```

## Run the App (Development)

Start the Vite development server:

```bash
npm run dev
```

Then open the URL shown in terminal (usually [http://localhost:5173](http://localhost:5173)).

## Start Server for Production Build Preview

1. Build the app:

```bash
npm run build
```

2. Start the preview server:

```bash
npm run preview
```

Preview usually runs at [http://localhost:4173](http://localhost:4173).

## Available Scripts

- `npm run dev` - start local development server with hot reload
- `npm run build` - create optimized production build in `dist/`
- `npm run preview` - serve production build locally
- `npm run lint` - run ESLint checks

## How to Use

1. Open the app in your browser.
2. Sign up or log in (credentials are stored in browser local storage).
3. Upload a `.csv` shipment file.
4. Ask a question such as:
   - "Which routes had the most delays last month?"
   - "Show average delay by carrier this month"
5. View chart/table output and export the report as PDF.

## CSV Requirements

Required fields in each row:

- `shipment_id`
- `route`
- `carrier`
- `origin`
- `destination`

Recommended additional fields for best insights:

- `planned_delivery_date`
- `actual_delivery_date`
- `shipment_date`
- `delay_minutes`
- `status`

Sample CSV files are available in the `public/` folder.

## Notes

- This repository currently runs a frontend app only; there is no separate backend server to start.
- User accounts and analysis history are stored in browser local storage.
