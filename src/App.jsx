import { useMemo, useRef, useState } from 'react'
import html2canvas from 'html2canvas'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import Papa from 'papaparse'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

const QUICK_PROMPTS = [
  'Which routes had the most delays last month?',
  'Show average delay by carrier this month',
  'Top 5 destinations with delayed shipments in last 30 days',
  'Create a table of delay count by route',
]

const KEY_SYNONYMS = {
  route: ['route', 'lane', 'shipping_lane', 'route_name'],
  carrier: ['carrier', 'driver', 'transporter', 'vendor'],
  destination: ['destination', 'destination_city', 'destination_hub', 'to_city'],
  origin: ['origin', 'source', 'from_city', 'origin_hub'],
  plannedDate: ['planned_delivery_date', 'eta', 'promised_date', 'expected_delivery_date'],
  actualDate: ['actual_delivery_date', 'delivered_at', 'delivery_date'],
  shipmentDate: ['shipment_date', 'pickup_date', 'dispatch_date', 'created_at'],
  delayMinutes: ['delay_minutes', 'delay_mins', 'delay', 'late_by_minutes'],
  status: ['status', 'shipment_status'],
}

const REQUIRED_FIELDS = ['shipment_id', 'route', 'carrier', 'origin', 'destination']

const USERS_STORAGE_KEY = 'logistics_users'
const SESSION_STORAGE_KEY = 'logistics_current_user'

function parseDate(value) {
  if (!value) {
    return null
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }

  return parsed
}

function minutesBetween(firstDate, secondDate) {
  return Math.round((secondDate.getTime() - firstDate.getTime()) / 60000)
}

function findValueBySynonyms(row, synonyms) {
  const normalizedKeys = Object.keys(row)
  for (const candidateKey of synonyms) {
    const direct = row[candidateKey]
    if (direct !== undefined) {
      return direct
    }

    const foundKey = normalizedKeys.find((key) => key.includes(candidateKey))
    if (foundKey) {
      return row[foundKey]
    }
  }
  return undefined
}

function normalizeRow(rawRow) {
  const normalized = {}
  for (const [key, value] of Object.entries(rawRow)) {
    if (!key) {
      continue
    }
    normalized[key.trim().toLowerCase().replace(/\s+/g, '_')] = value
  }
  return normalized
}

function validateRowsForEmptyRequiredFields(rows) {
  const rowErrors = []

  rows.forEach((row, index) => {
    const missing = REQUIRED_FIELDS.filter((field) => {
      const value = row[field]
      return value === undefined || `${value}`.trim() === ''
    })

    if (missing.length > 0) {
      rowErrors.push(`Row ${index + 2}: missing ${missing.join(', ')}`)
    }
  })

  return rowErrors
}

function addDerivedFields(rows) {
  return rows.map((row) => {
    const plannedDateRaw = findValueBySynonyms(row, KEY_SYNONYMS.plannedDate)
    const actualDateRaw = findValueBySynonyms(row, KEY_SYNONYMS.actualDate)
    const shipmentDateRaw = findValueBySynonyms(row, KEY_SYNONYMS.shipmentDate)
    const delayRaw = findValueBySynonyms(row, KEY_SYNONYMS.delayMinutes)
    const statusRaw = findValueBySynonyms(row, KEY_SYNONYMS.status)

    const plannedDate = parseDate(plannedDateRaw)
    const actualDate = parseDate(actualDateRaw)
    const shipmentDate = parseDate(shipmentDateRaw)

    let delayMinutes = Number(delayRaw)
    if (Number.isNaN(delayMinutes)) {
      delayMinutes = null
    }
    if (delayMinutes === null && plannedDate && actualDate) {
      delayMinutes = minutesBetween(plannedDate, actualDate)
    }

    const status = typeof statusRaw === 'string' ? statusRaw.toLowerCase() : ''
    const delayedByStatus = status.includes('delay') || status.includes('late')
    const isDelayed = delayedByStatus || (delayMinutes !== null && delayMinutes > 0)

    return {
      ...row,
      _plannedDate: plannedDate,
      _actualDate: actualDate,
      _shipmentDate: shipmentDate,
      _delayMinutes: delayMinutes,
      _isDelayed: isDelayed,
      _status: status,
    }
  })
}

function findDimensionFromQuestion(questionText) {
  if (questionText.includes('route')) return 'route'
  if (questionText.includes('carrier') || questionText.includes('driver') || questionText.includes('vendor')) {
    return 'carrier'
  }
  if (questionText.includes('destination') || questionText.includes('city') || questionText.includes('hub')) {
    return 'destination'
  }
  if (questionText.includes('origin')) return 'origin'
  return 'route'
}

function getDimensionValue(row, dimension) {
  return findValueBySynonyms(row, KEY_SYNONYMS[dimension])?.toString().trim() || 'Unknown'
}

function getTimeWindow(questionText) {
  const now = new Date()
  const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  if (questionText.includes('last month')) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = new Date(now.getFullYear(), now.getMonth(), 1)
    return { label: 'last month', start, end }
  }

  if (questionText.includes('this month')) {
    return { label: 'this month', start: startOfCurrentMonth, end: null }
  }

  const daysMatch = questionText.match(/last\s+(\d+)\s+days?/)
  if (daysMatch) {
    const numberOfDays = Number(daysMatch[1])
    const start = new Date(now)
    start.setDate(now.getDate() - numberOfDays)
    return { label: `last ${numberOfDays} days`, start, end: null }
  }

  const monthMatch = MONTH_NAMES.find((monthName) => questionText.includes(monthName))
  if (monthMatch) {
    const monthIndex = MONTH_NAMES.indexOf(monthMatch)
    const year = now.getFullYear()
    const start = new Date(year, monthIndex, 1)
    const end = new Date(year, monthIndex + 1, 1)
    return { label: monthMatch, start, end }
  }

  return { label: 'all time', start: null, end: null }
}

function isDateWithinRange(date, windowRange) {
  if (!date) {
    return false
  }
  if (windowRange.start && date < windowRange.start) {
    return false
  }
  if (windowRange.end && date >= windowRange.end) {
    return false
  }
  return true
}

function getRelevantDate(row) {
  return row._actualDate || row._plannedDate || row._shipmentDate
}

function aggregateData(rows, dimension, metric) {
  const grouped = new Map()

  rows.forEach((row) => {
    const label = getDimensionValue(row, dimension)
    const current = grouped.get(label) || {
      label,
      delayedCount: 0,
      shipmentCount: 0,
      totalDelayMinutes: 0,
    }

    current.shipmentCount += 1
    if (row._isDelayed) {
      current.delayedCount += 1
    }
    if (row._delayMinutes && row._delayMinutes > 0) {
      current.totalDelayMinutes += row._delayMinutes
    }

    grouped.set(label, current)
  })

  return Array.from(grouped.values()).map((item) => {
    if (metric === 'avg_delay') {
      const averageDelay = item.shipmentCount === 0 ? 0 : item.totalDelayMinutes / item.shipmentCount
      return {
        label: item.label,
        value: Number(averageDelay.toFixed(1)),
      }
    }

    if (metric === 'delay_minutes') {
      return {
        label: item.label,
        value: item.totalDelayMinutes,
      }
    }

    if (metric === 'shipment_count') {
      return {
        label: item.label,
        value: item.shipmentCount,
      }
    }

    return {
      label: item.label,
      value: item.delayedCount,
    }
  })
}

function detectMetric(questionText) {
  if (questionText.includes('average') || questionText.includes('avg')) return 'avg_delay'
  if (questionText.includes('minutes') || questionText.includes('total delay')) return 'delay_minutes'
  if (questionText.includes('shipments') || questionText.includes('volume')) return 'shipment_count'
  return 'delay_count'
}

function getTopN(questionText) {
  const topMatch = questionText.match(/top\s+(\d+)/)
  if (topMatch) {
    return Number(topMatch[1])
  }
  return 10
}

function getMetricLabel(metric) {
  switch (metric) {
    case 'avg_delay':
      return 'Avg Delay (mins)'
    case 'delay_minutes':
      return 'Total Delay (mins)'
    case 'shipment_count':
      return 'Shipment Count'
    default:
      return 'Delay Count'
  }
}

function createInsight(question, rows) {
  const questionText = question.toLowerCase().trim()
  if (!questionText) {
    return {
      error: 'Please enter a question to analyze the uploaded shipment data.',
    }
  }

  if (!rows.length) {
    return {
      error: 'Upload a CSV file first. No shipment records are loaded yet.',
    }
  }

  const timeWindow = getTimeWindow(questionText)
  const filteredRows = rows.filter((row) => {
    const relevantDate = getRelevantDate(row)
    if (!timeWindow.start && !timeWindow.end) {
      return true
    }
    return isDateWithinRange(relevantDate, timeWindow)
  })

  if (!filteredRows.length) {
    return {
      error: `No records found for ${timeWindow.label}. Try a broader date range.`,
    }
  }

  const dimension = findDimensionFromQuestion(questionText)
  const metric = detectMetric(questionText)
  const topN = getTopN(questionText)
  const metricLabel = getMetricLabel(metric)

  const aggregatedRows = aggregateData(filteredRows, dimension, metric)
    .sort((first, second) => second.value - first.value)
    .slice(0, topN)

  const wantsTable = questionText.includes('table') || questionText.includes('list')
  const wantsChart = questionText.includes('chart') || questionText.includes('graph')

  const topRow = aggregatedRows[0]
  const narrative = topRow
    ? `${topRow.label} has the highest ${metricLabel.toLowerCase()} (${topRow.value}) for ${timeWindow.label}.`
    : `No grouped results found for ${timeWindow.label}.`

  return {
    title: `Insights by ${dimension}`,
    metricLabel,
    dimensionLabel: `${dimension[0].toUpperCase()}${dimension.slice(1)}`,
    narrative,
    filteredCount: filteredRows.length,
    rows: aggregatedRows,
    showTable: wantsTable || !wantsChart,
    showChart: wantsChart || !wantsTable,
  }
}

function getHistoryStorageKey(email) {
  return `logistics_history_${email.toLowerCase()}`
}

function readUsersFromStorage() {
  try {
    const raw = localStorage.getItem(USERS_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readSessionUser() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function readHistoryForUser(email) {
  if (!email) {
    return []
  }

  try {
    const key = getHistoryStorageKey(email)
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function blobToDataUrl(blobData) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(blobData)
  })
}

async function getPdfHeaderLogoDataUrl() {
  try {
    const response = await fetch('/codebrew-black-logo.webp')
    if (!response.ok) {
      return null
    }
    const logoBlob = await response.blob()
    const logoDataUrl = await blobToDataUrl(logoBlob)
    return typeof logoDataUrl === 'string' ? logoDataUrl : null
  } catch {
    return null
  }
}

function App() {
  const [fileName, setFileName] = useState('')
  const [query, setQuery] = useState(QUICK_PROMPTS[0])
  const [rawRows, setRawRows] = useState([])
  const [uploadErrors, setUploadErrors] = useState([])
  const [insight, setInsight] = useState(null)

  const [authMode, setAuthMode] = useState('login')
  const [authError, setAuthError] = useState('')
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' })
  const [currentUser, setCurrentUser] = useState(() => readSessionUser())
  const [historyItems, setHistoryItems] = useState(() => {
    const sessionUser = readSessionUser()
    return readHistoryForUser(sessionUser?.email)
  })
  const [activeHistoryId, setActiveHistoryId] = useState(null)
  const [isSidebarVisible, setIsSidebarVisible] = useState(true)
  const [isCsvPopupOpen, setIsCsvPopupOpen] = useState(false)
  const [isExportingReport, setIsExportingReport] = useState(false)

  const chartExportRef = useRef(null)

  const normalizedRows = useMemo(() => addDerivedFields(rawRows), [rawRows])
  const columnNames = useMemo(() => {
    if (!rawRows.length) {
      return []
    }
    return Object.keys(rawRows[0])
  }, [rawRows])

  function persistHistory(nextHistory) {
    setHistoryItems(nextHistory)
    if (!currentUser?.email) {
      return
    }
    localStorage.setItem(getHistoryStorageKey(currentUser.email), JSON.stringify(nextHistory))
  }

  function addHistoryItem(entry) {
    const historyEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      ...entry,
    }
    const next = [historyEntry, ...historyItems].slice(0, 40)
    persistHistory(next)
    return historyEntry.id
  }

  function updateHistoryResult(historyId, result, questionText) {
    if (!historyId) {
      return
    }

    const next = historyItems.map((item) => {
      if (item.id !== historyId) {
        return item
      }

      return {
        ...item,
        question: questionText,
        note: result.error ? result.error : result.narrative,
        insight: sanitizeInsightForHistory(result),
        updatedAt: new Date().toISOString(),
      }
    })

    persistHistory(next)
  }

  function sanitizeInsightForHistory(currentInsight) {
    if (!currentInsight) {
      return null
    }

    if (currentInsight.error) {
      return { error: currentInsight.error }
    }

    return {
      title: currentInsight.title,
      metricLabel: currentInsight.metricLabel,
      dimensionLabel: currentInsight.dimensionLabel,
      narrative: currentInsight.narrative,
      filteredCount: currentInsight.filteredCount,
      rows: Array.isArray(currentInsight.rows) ? currentInsight.rows.slice(0, 20) : [],
      showTable: currentInsight.showTable,
      showChart: currentInsight.showChart,
    }
  }

  function handleAuthSubmit(event) {
    event.preventDefault()
    setAuthError('')

    const email = authForm.email.trim().toLowerCase()
    const password = authForm.password
    const name = authForm.name.trim()

    if (!email || !password || (authMode === 'signup' && !name)) {
      setAuthError('Please fill all required fields.')
      return
    }

    const users = readUsersFromStorage()

    if (authMode === 'signup') {
      const exists = users.some((user) => user.email === email)
      if (exists) {
        setAuthError('User already exists. Please login instead.')
        return
      }

      const newUser = { name, email, password }
      const nextUsers = [...users, newUser]
      localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(nextUsers))
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ name, email }))
      setCurrentUser({ name, email })
      setHistoryItems(readHistoryForUser(email))
      return
    }

    const existingUser = users.find((user) => user.email === email && user.password === password)
    if (!existingUser) {
      setAuthError('Invalid email or password.')
      return
    }

    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ name: existingUser.name, email: existingUser.email }),
    )
    setCurrentUser({ name: existingUser.name, email: existingUser.email })
    setHistoryItems(readHistoryForUser(existingUser.email))
  }

  function handleLogout() {
    if (!window.confirm('Are you sure you want to logout?')) {
      return
    }

    localStorage.removeItem(SESSION_STORAGE_KEY)
    setCurrentUser(null)
    setHistoryItems([])
    setActiveHistoryId(null)
    setRawRows([])
    setInsight(null)
    setFileName('')
    setUploadErrors([])
  }

  function handleClearHistory() {
    if (!window.confirm('Clear all history for this account?')) {
      return
    }

    setHistoryItems([])
    setActiveHistoryId(null)
    if (currentUser?.email) {
      localStorage.removeItem(getHistoryStorageKey(currentUser.email))
    }
  }

  function handleFileUpload(event) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    const hasCsvName = file.name.toLowerCase().endsWith('.csv')
    const isCsvMimeType =
      file.type === '' || file.type === 'text/csv' || file.type === 'application/vnd.ms-excel'

    if (!hasCsvName || !isCsvMimeType) {
      setFileName('')
      setRawRows([])
      setInsight(null)
      setUploadErrors(['Invalid file. Please upload a valid .csv file.'])
      return
    }

    setFileName(file.name)
    setUploadErrors([])
    setInsight(null)

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (result) => {
        const validationErrors = []

        if (!Array.isArray(result.data) || result.data.length === 0) {
          validationErrors.push('CSV file is empty or has no readable rows.')
        }

        if (result.errors.length > 0) {
          validationErrors.push('Corrupted CSV detected: unable to parse some rows.')
          result.errors.slice(0, 3).forEach((error) => {
            validationErrors.push(`Parse error row ${error.row ?? '?'}: ${error.message}`)
          })
        }

        const cleanedRows = (Array.isArray(result.data) ? result.data : [])
          .filter((row) => Object.values(row).some((value) => `${value ?? ''}`.trim() !== ''))
          .map(normalizeRow)

        if (cleanedRows.length === 0) {
          validationErrors.push('CSV has no usable data rows.')
        }

        const fieldErrors = validateRowsForEmptyRequiredFields(cleanedRows)
        if (fieldErrors.length > 0) {
          validationErrors.push('Some rows have empty required fields.')
          validationErrors.push(...fieldErrors.slice(0, 8))
          if (fieldErrors.length > 8) {
            validationErrors.push(`...and ${fieldErrors.length - 8} more row validation errors.`)
          }
        }

        if (validationErrors.length > 0) {
          setRawRows([])
          setUploadErrors(validationErrors)
          return
        }

        setRawRows(cleanedRows)
        setUploadErrors([])
        const newHistoryId = addHistoryItem({
          fileName: file.name,
          question: '',
          recordCount: cleanedRows.length,
          note: `Uploaded ${cleanedRows.length} records`,
          insight: null,
          csvRows: cleanedRows,
          csvColumns: Object.keys(cleanedRows[0] || {}),
        })
        setActiveHistoryId(newHistoryId)
      },
      error: () => {
        setRawRows([])
        setUploadErrors(['Failed to read file. Corrupted or unsupported CSV.'])
      },
    })
  }

  function runAnalysis() {
    const result = createInsight(query, normalizedRows)
    setInsight(result)

    updateHistoryResult(activeHistoryId, result, query)
  }

  async function exportReport() {
    if (!insight || insight.error || !Array.isArray(insight.rows) || insight.rows.length === 0) {
      window.alert('Run a valid analysis first, then export the report.')
      return
    }

    setIsExportingReport(true)

    try {
      const documentPdf = new jsPDF({ unit: 'pt', format: 'a4' })
      const pageWidth = documentPdf.internal.pageSize.getWidth()
      const pageHeight = documentPdf.internal.pageSize.getHeight()
      const margin = 40
      const contentWidth = pageWidth - margin * 2
      let cursorY = margin

      const logoDataUrl = await getPdfHeaderLogoDataUrl()
      if (logoDataUrl) {
        const logoWidth = 120
        const logoHeight = 36
        const logoX = (pageWidth - logoWidth) / 2
        documentPdf.addImage(logoDataUrl, 'WEBP', logoX, cursorY, logoWidth, logoHeight)
        cursorY += logoHeight + 14
      }

      documentPdf.setFontSize(16)
      documentPdf.text(insight.title || 'Shipment Insights Report', margin, cursorY)
      cursorY += 22

      documentPdf.setFontSize(10)
      const summaryLines = [
        `File: ${fileName || 'N/A'}`,
        `Question: ${query || 'N/A'}`,
        `Generated: ${new Date().toLocaleString()}`,
        `Analyzed Shipments: ${insight.filteredCount ?? 0}`,
      ]
      summaryLines.forEach((lineText) => {
        documentPdf.text(lineText, margin, cursorY)
        cursorY += 14
      })
      cursorY += 8

      if (insight.showChart && chartExportRef.current) {
        const chartCanvas = await html2canvas(chartExportRef.current, {
          backgroundColor: '#ffffff',
          scale: 2,
          useCORS: true,
        })

        const chartImage = chartCanvas.toDataURL('image/png')
        const imageWidth = contentWidth
        const imageHeight = (chartCanvas.height * imageWidth) / chartCanvas.width

        if (cursorY + imageHeight > pageHeight - margin) {
          documentPdf.addPage()
          cursorY = margin
        }

        documentPdf.text('Chart Snapshot', margin, cursorY)
        cursorY += 12
        documentPdf.addImage(chartImage, 'PNG', margin, cursorY, imageWidth, imageHeight)
        cursorY += imageHeight + 14
      }

      const shouldAddTable = insight.showTable || !insight.showChart
      if (shouldAddTable) {
        autoTable(documentPdf, {
          startY: Math.min(cursorY, pageHeight - margin),
          head: [[insight.dimensionLabel, insight.metricLabel]],
          body: insight.rows.map((row) => [row.label, row.value]),
          margin: { left: margin, right: margin },
          styles: { fontSize: 9, cellPadding: 5 },
          headStyles: { fillColor: [37, 99, 235] },
        })
      }

      const safeFileName = (fileName || 'shipment_report').replace(/[^a-zA-Z0-9_-]+/g, '_')
      documentPdf.save(`${safeFileName}_report.pdf`)
    } catch {
      window.alert('Failed to export PDF report. Please try again.')
    } finally {
      setIsExportingReport(false)
    }
  }

  function loadHistoryResult(item) {
    if (!item) {
      return
    }

    if (item.question) {
      setQuery(item.question)
    }

    if (item.fileName) {
      setFileName(item.fileName)
    }

    if (Array.isArray(item.csvRows) && item.csvRows.length > 0) {
      setRawRows(item.csvRows)
      setUploadErrors([])
    } else {
      setRawRows([])
      setUploadErrors([
        'Stored CSV rows are not available for this history item. Please upload the file again.',
      ])
    }

    setActiveHistoryId(item.id)

    if (item.insight) {
      setInsight(item.insight)
    } else {
      setInsight({
        error: 'This file has no saved result yet. Upload it again and run analysis to view results.',
      })
    }
  }

  if (!currentUser) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="top-logo-wrap">
            <img src="/codebrew-black-logo.webp" alt="Codebrew logo" className="top-logo-image" />
          </div>
          <p className="tag">Logistics Ops Assistant</p>
          <h1>{authMode === 'login' ? 'Login' : 'Create Account'}</h1>
          <p className="subtitle">Secure access for managers to upload CSVs and review shipment insights.</p>

          <form onSubmit={handleAuthSubmit} className="auth-form">
            {authMode === 'signup' ? (
              <input
                type="text"
                placeholder="Full name"
                value={authForm.name}
                onChange={(event) => setAuthForm((prev) => ({ ...prev, name: event.target.value }))}
              />
            ) : null}
            <input
              type="email"
              placeholder="Email"
              value={authForm.email}
              onChange={(event) => setAuthForm((prev) => ({ ...prev, email: event.target.value }))}
            />
            <input
              type="password"
              placeholder="Password"
              value={authForm.password}
              onChange={(event) => setAuthForm((prev) => ({ ...prev, password: event.target.value }))}
            />
            {authError ? <p className="error">{authError}</p> : null}
            <button type="submit">{authMode === 'login' ? 'Login' : 'Sign Up'}</button>
          </form>

          <button
            type="button"
            className="switch-link"
            onClick={() => {
              setAuthError('')
              setAuthMode((prev) => (prev === 'login' ? 'signup' : 'login'))
            }}
          >
            {authMode === 'login'
              ? "Don't have an account? Sign up"
              : 'Already have an account? Login'}
          </button>
        </section>
      </main>
    )
  }

  return (
    <main className={`workspace-layout ${isSidebarVisible ? '' : 'sidebar-hidden'}`}>
      <aside className="lhs-menu">
        <button
          type="button"
          className="hide-menu-button icon-toggle-button"
          onClick={() => setIsSidebarVisible(false)}
          aria-label="Hide menu"
          title="Hide menu"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 6L9 12L15 18" />
          </svg>
        </button>
        <button type="button" className="profile-button">
          <span className="avatar-circle">{currentUser.name?.[0]?.toUpperCase() ?? 'U'}</span>
          <span>
            <strong>{currentUser.name}</strong>
            <small>{currentUser.email}</small>
          </span>
        </button>

        <section className="history-box">
          <div className="history-header">
            <h3>History</h3>
            <button type="button" className="clear-history-button" onClick={handleClearHistory}>
              Clear History
            </button>
          </div>
          {historyItems.length === 0 ? <p className="meta">No uploaded files yet.</p> : null}
          <div className="history-list">
            {historyItems.map((item) => (
              <button
                type="button"
                key={item.id}
                className="history-item"
                onClick={() => loadHistoryResult(item)}
              >
                <p>{item.fileName || 'Uploaded CSV'}</p>
                <small>{new Date(item.createdAt).toLocaleString()}</small>
                {item.question ? <small>Last question: {item.question}</small> : null}
              </button>
            ))}
          </div>
        </section>
      </aside>

      <section className="main-content">
        <div className="top-logo-wrap">
          <img src="/codebrew-black-logo.webp" alt="Codebrew logo" className="top-logo-image" />
        </div>
        <div className="main-toolbar">
          <div className="main-toolbar-left">
            {!isSidebarVisible ? (
              <button
                type="button"
                className="show-menu-button icon-toggle-button"
                onClick={() => setIsSidebarVisible(true)}
                aria-label="Show menu"
                title="Show menu"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="5" cy="7" r="1.2" />
                  <circle cx="5" cy="12" r="1.2" />
                  <circle cx="5" cy="17" r="1.2" />
                  <path d="M9 7H19" />
                  <path d="M9 12H19" />
                  <path d="M9 17H19" />
                </svg>
              </button>
            ) : null}
          </div>
          <button type="button" className="top-logout-button" onClick={handleLogout}>
            Logout
          </button>
        </div>
        <header className="hero">
          <p className="tag">Logistics Ops Assistant</p>
          <h1>Ask shipment questions in plain English</h1>
          <p className="subtitle">
            Upload a CSV and ask questions like route delays, carrier performance, and destination trends.
          </p>
        </header>

        <section className="panel">
          <h2>1) Upload Shipment CSV</h2>
          <input type="file" accept=".csv" onChange={handleFileUpload} />
          {fileName ? <p className="meta">Loaded file: {fileName}</p> : null}
          {rawRows.length > 0 ? (
            <div className="upload-actions-row">
              <p className="meta">
                Records: {rawRows.length} | Columns: {columnNames.join(', ')}
              </p>
              <button type="button" className="view-csv-button" onClick={() => setIsCsvPopupOpen(true)}>
                View Full CSV
              </button>
            </div>
          ) : null}
          {uploadErrors.length > 0 ? (
            <div className="error-alert" role="alert" aria-live="assertive">
              <p className="error-title">Upload validation failed:</p>
              <ul>
                {uploadErrors.map((errorText) => (
                  <li key={errorText}>{errorText}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <h2>2) Ask a Question</h2>
          <div className="prompt-grid">
            {QUICK_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className="prompt-pill"
                onClick={() => setQuery(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
          <div className="question-row">
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Which routes had the most delays last month?"
            />
            <button type="button" onClick={runAnalysis}>
              Run Analysis
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>3) Result</h2>
          {!insight ? (
            <p className="meta">Run a question after uploading data to see a chart or table.</p>
          ) : null}
          {insight?.error ? <p className="error">{insight.error}</p> : null}
          {insight && !insight.error ? (
            <>
              <div className="result-header-row">
                <p className="result-title">{insight.title}</p>
                <button
                  type="button"
                  className="export-report-button"
                  onClick={exportReport}
                  disabled={isExportingReport}
                >
                  {isExportingReport ? 'Exporting...' : 'Export Report PDF'}
                </button>
              </div>
              <p className="meta">
                {insight.narrative} Analyzed {insight.filteredCount} shipments.
              </p>

              {insight.showChart ? (
                <div className="chart-box" ref={chartExportRef}>
                  <ResponsiveContainer width="100%" height={340}>
                    <BarChart data={insight.rows} margin={{ top: 12, right: 12, bottom: 16, left: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" angle={-25} textAnchor="end" interval={0} height={70} />
                      <YAxis />
                      <Tooltip />
                      <Bar dataKey="value" fill="#2563eb" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : null}

              {insight.showTable ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{insight.dimensionLabel}</th>
                        <th>{insight.metricLabel}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {insight.rows.map((row) => (
                        <tr key={row.label}>
                          <td>{row.label}</td>
                          <td>{row.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          ) : null}
        </section>

        <section className="panel">
          <h2>Expected CSV Fields</h2>
          <p className="meta">
            Best results when your CSV includes route/carrier/origin/destination and planned or actual
            delivery dates. Delay can be either a numeric delay column or inferred from planned vs actual
            dates.
          </p>
          <p className="meta">
            Example columns: <code>route</code>, <code>carrier</code>, <code>destination</code>,{' '}
            <code>planned_delivery_date</code>, <code>actual_delivery_date</code>,{' '}
            <code>delay_minutes</code>, <code>status</code>
          </p>
        </section>
      </section>

      {isCsvPopupOpen ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="CSV preview popup">
          <div className="modal-card">
            <div className="modal-header">
              <h3>CSV Preview: {fileName || 'Uploaded File'}</h3>
              <button type="button" className="modal-close-button" onClick={() => setIsCsvPopupOpen(false)}>
                Close
              </button>
            </div>
            <div className="modal-table-wrap">
              <table>
                <thead>
                  <tr>
                    {columnNames.map((columnName) => (
                      <th key={columnName}>{columnName}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rawRows.map((row, index) => (
                    <tr key={`csv_row_${index + 1}`}>
                      {columnNames.map((columnName) => (
                        <td key={`${columnName}_${index + 1}`}>{row[columnName] || '-'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default App
