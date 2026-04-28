import { useEffect, useMemo, useState } from 'react'
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

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''
const API_PREFIX = import.meta.env.VITE_API_PREFIX || '/api/v1'

const QUICK_PROMPTS = [
  'Which routes had the most delays last month?',
  'Show average delay by carrier this month',
  'Top 5 destinations with delayed shipments in last 30 days',
  'Create a table of delay count by route',
]

const SESSION_STORAGE_KEY = 'logistics_api_session'

function getApiUrl(path) {
  return `${API_BASE_URL}${path}`
}

function readSessionFromStorage() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed?.accessToken || !parsed?.refreshToken || !parsed?.user) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function pickList(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.items)) return payload.items
  if (Array.isArray(payload?.rows)) return payload.rows
  if (Array.isArray(payload?.records)) return payload.records
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function getErrorMessage(payload, fallbackMessage) {
  const errorTextFromItem = (item) => {
    if (!item) return ''
    if (typeof item === 'string') return item
    if (item.detail) return item.detail
    if (item.message) return item.message
    if (item.msg) return item.msg
    if (item.constraints && typeof item.constraints === 'object') {
      return Object.values(item.constraints).filter(Boolean).join(', ')
    }
    return ''
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const combinedErrors = payload.errors
      .map((item) => {
        const reason = errorTextFromItem(item)
        const field = item?.field || item?.path || item?.param
        if (!reason) return ''
        return field ? `${field}: ${reason}` : reason
      })
      .filter(Boolean)
      .join(' | ')

    if (combinedErrors) {
      return combinedErrors
    }
  }

  if (typeof payload?.error === 'string' && payload.error.trim()) {
    return payload.error
  }
  if (payload?.message) return payload.message
  return fallbackMessage
}

function normalizeInsight(rawData) {
  const source = rawData?.result || rawData?.insight || rawData
  if (!source || source.error) {
    return { error: source?.error || 'No analysis result returned from server.' }
  }
  return {
    title: source.title || 'Analysis Result',
    metricLabel: source.metricLabel || 'Value',
    dimensionLabel: source.dimensionLabel || 'Dimension',
    narrative: source.narrative || 'Analysis completed.',
    filteredCount: Number(source.filteredCount || 0),
    rows: Array.isArray(source.rows) ? source.rows : [],
    showTable: source.showTable ?? true,
    showChart: source.showChart ?? true,
  }
}

function App() {
  const [fileName, setFileName] = useState('')
  const [query, setQuery] = useState(QUICK_PROMPTS[0])
  const [rawRows, setRawRows] = useState([])
  const [datasetColumns, setDatasetColumns] = useState([])
  const [datasetId, setDatasetId] = useState('')
  const [uploadErrors, setUploadErrors] = useState([])
  const [insight, setInsight] = useState(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isRunningAnalysis, setIsRunningAnalysis] = useState(false)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)

  const [authMode, setAuthMode] = useState('login')
  const [authError, setAuthError] = useState('')
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' })
  const [session, setSession] = useState(() => readSessionFromStorage())
  const [historyItems, setHistoryItems] = useState([])
  const [isSidebarVisible, setIsSidebarVisible] = useState(true)
  const [isCsvPopupOpen, setIsCsvPopupOpen] = useState(false)
  const [isExportingReport, setIsExportingReport] = useState(false)

  const currentUser = session?.user || null
  const columnNames = useMemo(() => {
    if (rawRows.length > 0) {
      return Object.keys(rawRows[0])
    }
    return Array.isArray(datasetColumns) ? datasetColumns : []
  }, [datasetColumns, rawRows])

  function persistSession(nextSession) {
    if (!nextSession) {
      localStorage.removeItem(SESSION_STORAGE_KEY)
      setSession(null)
      return
    }
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(nextSession))
    setSession(nextSession)
  }

  async function apiRequest(path, options = {}) {
    const { token, body, isFormData = false, method = 'GET' } = options
    const headers = {}
    if (!isFormData) {
      headers['Content-Type'] = 'application/json'
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const response = await fetch(getApiUrl(path), {
      method,
      headers,
      body: body ? (isFormData ? body : JSON.stringify(body)) : undefined,
    })

    const contentType = response.headers.get('content-type') || ''
    const payload = contentType.includes('application/json') ? await response.json() : null
    if (!response.ok) {
      throw new Error(getErrorMessage(payload, `Request failed (${response.status})`))
    }
    return payload
  }

  async function refreshAccessToken() {
    if (!session?.refreshToken) {
      throw new Error('Session expired. Please login again.')
    }
    const response = await apiRequest(`${API_PREFIX}/auth/refresh`, {
      method: 'POST',
      body: { refreshToken: session.refreshToken },
    })
    const data = response?.data || {}
    const nextSession = {
      user: data.user || session.user,
      accessToken: data.accessToken || session.accessToken,
      refreshToken: data.refreshToken || session.refreshToken,
    }
    if (!nextSession.accessToken || !nextSession.refreshToken) {
      throw new Error('Session refresh failed. Please login again.')
    }
    persistSession(nextSession)
    return nextSession.accessToken
  }

  async function apiWithAuth(path, options = {}) {
    try {
      return await apiRequest(path, { ...options, token: session?.accessToken })
    } catch (error) {
      const message = `${error?.message || ''}`.toLowerCase()
      if (!message.includes('401') && !message.includes('unauthorized')) {
        throw error
      }
      const nextToken = await refreshAccessToken()
      return apiRequest(path, { ...options, token: nextToken })
    }
  }

  async function loadHistories() {
    if (!currentUser) return
    setIsLoadingHistory(true)
    try {
      const [uploadsResponse, analysesResponse] = await Promise.all([
        apiWithAuth(`${API_PREFIX}/history/uploads?page=1&limit=50`),
        apiWithAuth(`${API_PREFIX}/history/analyses?page=1&limit=50`),
      ])

      const uploadItems = pickList(uploadsResponse?.data).map((item) => ({
        id: `upload_${item.id || item.datasetId || Math.random().toString(36).slice(2, 8)}`,
        recordId: item.id || '',
        type: 'upload',
        datasetId: item.datasetId || item.id || '',
        fileName: item.fileName || item.name || 'Uploaded CSV',
        question: '',
        note: item.note || `Uploaded ${item.recordCount || 0} records`,
        createdAt: item.createdAt || item.uploadedAt || new Date().toISOString(),
      }))

      const analysisItems = pickList(analysesResponse?.data).map((item) => ({
        id: `analysis_${item.id || Math.random().toString(36).slice(2, 8)}`,
        recordId: item.id || '',
        type: 'analysis',
        datasetId: item.datasetId || '',
        fileName: item.fileName || 'Analysis',
        question: item.query || item.question || '',
        note: item.note || item.result?.narrative || item.insight?.narrative || 'Analysis completed',
        createdAt: item.createdAt || new Date().toISOString(),
        insight: item.result || item.insight || null,
      }))

      const merged = [...uploadItems, ...analysisItems].sort(
        (first, second) => new Date(second.createdAt) - new Date(first.createdAt),
      )
      setHistoryItems(merged)
    } catch (error) {
      setAuthError(error.message || 'Failed to load history.')
    } finally {
      setIsLoadingHistory(false)
    }
  }

  async function loadDatasetDetails(datasetIdentifier) {
    if (!datasetIdentifier) {
      return
    }
    const response = await apiWithAuth(`${API_PREFIX}/datasets/${datasetIdentifier}`)
    const data = response?.data || {}
    const rows = Array.isArray(data.rows) ? data.rows : Array.isArray(data.csvRows) ? data.csvRows : []
    const columns = Array.isArray(data.columns)
      ? data.columns
      : rows.length > 0
        ? Object.keys(rows[0])
        : []

    setDatasetId(datasetIdentifier)
    setFileName(data.fileName || data.name || fileName)
    setRawRows(rows)
    setDatasetColumns(columns)
    if (rows.length === 0) {
      setUploadErrors([
        'Dataset loaded, but row preview is not returned by this API. Upload endpoint still works correctly.',
      ])
    } else {
      setUploadErrors([])
    }
  }

  useEffect(() => {
    if (currentUser) {
      const timerId = window.setTimeout(() => {
        loadHistories()
      }, 0)
      return () => window.clearTimeout(timerId)
    }
    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser])

  async function handleAuthSubmit(event) {
    event.preventDefault()
    setAuthError('')

    const email = authForm.email.trim().toLowerCase()
    const password = authForm.password
    const name = authForm.name.trim()

    if (!email || !password || (authMode === 'signup' && !name.trim())) {
      setAuthError('Please fill all required fields.')
      return
    }

    const endpoint = authMode === 'signup' ? '/auth/signup' : '/auth/login'
    const body =
      authMode === 'signup' ? { name: name.trim(), email, password } : { email, password }

    try {
      const response = await apiRequest(`${API_PREFIX}${endpoint}`, {
        method: 'POST',
        body,
      })
      const data = response?.data || {}
      if (!data.accessToken || !data.refreshToken) {
        throw new Error('Invalid auth response from server.')
      }
      const user = data.user || { name: name.trim() || 'User', email }
      persistSession({
        user,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
      })
      setAuthForm({ name: '', email: '', password: '' })
      setUploadErrors([])
      setInsight(null)
    } catch (error) {
      setAuthError(error.message || 'Authentication failed.')
    }
  }

  async function handleLogout() {
    if (!window.confirm('Are you sure you want to logout?')) {
      return
    }

    try {
      if (session?.accessToken && session?.refreshToken) {
        await apiRequest(`${API_PREFIX}/auth/logout`, {
          method: 'POST',
          token: session.accessToken,
          body: { refreshToken: session.refreshToken },
        })
      }
    } catch {
      // Ignore logout API failure and clear local session.
    }

    persistSession(null)
    setHistoryItems([])
    setRawRows([])
    setDatasetColumns([])
    setDatasetId('')
    setInsight(null)
    setFileName('')
    setUploadErrors([])
  }

  async function handleClearHistory() {
    if (!window.confirm('Clear all analysis history for this account?')) {
      return
    }

    try {
      let page = 1
      let hasMore = true
      while (hasMore) {
        const response = await apiWithAuth(`${API_PREFIX}/history/analyses?page=${page}&limit=50`)
        const records = pickList(response?.data)
        if (records.length === 0) {
          hasMore = false
          break
        }
        await Promise.all(
          records
            .map((record) => record?.id)
            .filter(Boolean)
            .map((recordId) => apiWithAuth(`${API_PREFIX}/history/analyses/${recordId}`, { method: 'DELETE' })),
        )
        page += 1
      }
      await loadHistories()
      setInsight(null)
    } catch (error) {
      setUploadErrors([error.message || 'Failed to clear history.'])
    }
  }

  async function handleFileUpload(event) {
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
      setDatasetColumns([])
      setDatasetId('')
      setInsight(null)
      setUploadErrors(['Invalid file. Please upload a valid .csv file.'])
      return
    }

    setFileName(file.name)
    setUploadErrors([])
    setInsight(null)
    setIsUploading(true)

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('name', fileName.replace(/\.csv$/i, ''))

      const response = await apiWithAuth(`${API_PREFIX}/datasets/upload`, {
        method: 'POST',
        isFormData: true,
        body: formData,
      })
      const data = response?.data || {}
      setDatasetId(data.id || data.datasetId || '')
      setDatasetColumns(Array.isArray(data.columns) ? data.columns : [])
      setRawRows(Array.isArray(data.rows) ? data.rows : [])
      setUploadErrors(Array.isArray(data.validationErrors) ? data.validationErrors : [])
      await loadHistories()
    } catch (error) {
      setRawRows([])
      setDatasetColumns([])
      setDatasetId('')
      setUploadErrors([error.message || 'Failed to upload CSV.'])
    } finally {
      setIsUploading(false)
    }
  }

  async function runAnalysis() {
    if (!datasetId) {
      setInsight({ error: 'Upload a CSV first to get a dataset ID.' })
      return
    }

    setIsRunningAnalysis(true)
    try {
      const response = await apiWithAuth(`${API_PREFIX}/analysis/run`, {
        method: 'POST',
        body: { query, datasetId },
      })
      const data = response?.data || {}
      setInsight(normalizeInsight(data))
      await loadHistories()
    } catch (error) {
      setInsight({ error: error.message || 'Failed to run analysis.' })
    } finally {
      setIsRunningAnalysis(false)
    }
  }

  async function exportReport() {
    setIsExportingReport(true)
    try {
      const response = await fetch(getApiUrl(`${API_PREFIX}/reports/analysis.pdf`), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${session?.accessToken || ''}`,
        },
      })

      if (!response.ok) {
        throw new Error(`Report download failed (${response.status})`)
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${(fileName || 'analysis').replace(/[^a-zA-Z0-9_-]+/g, '_')}_report.pdf`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      window.alert('Failed to download analysis PDF report.')
    } finally {
      setIsExportingReport(false)
    }
  }

  async function loadHistoryResult(item) {
    if (!item) {
      return
    }

    if (item.question) {
      setQuery(item.question)
    }

    if (item.fileName) {
      setFileName(item.fileName)
    }

    try {
      if (item.datasetId) {
        await loadDatasetDetails(item.datasetId)
      }
    } catch (error) {
      setUploadErrors([error.message || 'Failed to load dataset details.'])
    }

    if (item.type === 'analysis') {
      setInsight(normalizeInsight(item.insight))
    } else {
      setInsight(null)
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
          {isLoadingHistory ? <p className="meta">Loading history...</p> : null}
          {!isLoadingHistory && historyItems.length === 0 ? (
            <p className="meta">No uploads or analyses yet.</p>
          ) : null}
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
                <small>Type: {item.type}</small>
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
          {datasetId ? <p className="meta">Dataset ID: {datasetId}</p> : null}
          {isUploading ? <p className="meta">Uploading CSV...</p> : null}
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
              {isRunningAnalysis ? 'Running...' : 'Run Analysis'}
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
                <div className="chart-box">
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
          <p className="meta">
            API base: <code>{API_BASE_URL}</code> | Prefix: <code>{API_PREFIX}</code>
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
                  {rawRows.length > 0 ? rawRows.map((row, index) => (
                    <tr key={`csv_row_${index + 1}`}>
                      {columnNames.map((columnName) => (
                        <td key={`${columnName}_${index + 1}`}>{row[columnName] || '-'}</td>
                      ))}
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan={Math.max(columnNames.length, 1)}>
                        Preview rows are not returned by the current dataset API response.
                      </td>
                    </tr>
                  )}
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
