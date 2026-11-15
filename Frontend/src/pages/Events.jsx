import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api.js'
import { useAuth } from '../auth.jsx'
import DateRange from '../DateRange.jsx'
import { centreInJapan, lastMonths, overlapsRange, statusLabel } from '../explore.js'
import './Events.css'

// Live data from the Earth Replay API: the catalog of tracked events, what
// NISAR has for each, and the AI briefing and question box.

function formatDay(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function EventList({ selectedId, range }) {
  const [events, setEvents] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    api
      .events()
      .then((data) => !cancelled && setEvents(data.events))
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [])

  if (error) return <p className="error">{error}</p>
  if (!events) return <p className="ev-muted">Loading events…</p>
  if (events.length === 0) {
    return <p className="ev-muted">No events have been registered yet.</p>
  }

  // Events whose dates touch the chosen period (the open one always stays in the list).
  const shown = events.filter((e) => e.id === selectedId || overlapsRange(e, range))

  return (
    <>
      <p className="ev-muted ev-count">
        {shown.length} of {events.length} event{events.length === 1 ? '' : 's'} in this period
      </p>
      {shown.length === 0 && <p className="ev-muted">No events in this period. Try a longer one.</p>}
      <ul className="ev-list">
        {shown.map((event) => (
          <li key={event.id}>
            <Link
              to={`/events/${event.id}`}
              className={event.id === selectedId ? 'ev-item ev-item-active' : 'ev-item'}
            >
              <span className="ev-item-name">{event.name}</span>
              <span className="ev-item-meta">
                {event.type} · {event.sceneCount ?? 0} scenes
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}

function Briefing({ eventId }) {
  const [state, setState] = useState({ status: 'idle' })

  const load = () => {
    setState({ status: 'loading' })
    api
      .summary(eventId)
      .then((data) => setState({ status: 'done', data }))
      .catch((err) => setState({ status: 'error', message: err.message }))
  }

  return (
    <section className="ev-card">
      <h3>AI briefing</h3>
      {state.status === 'idle' && (
        <button className="button" onClick={load}>Write a briefing</button>
      )}
      {state.status === 'loading' && <p className="ev-muted">Writing…</p>}
      {state.status === 'error' && (
        <>
          <p className="error">{state.message}</p>
          <button className="button secondary" onClick={load}>Try again</button>
        </>
      )}
      {state.status === 'done' && (
        <>
          <p className="ev-answer">{state.data.summary}</p>
          <p className="ev-fine">{state.data.disclaimer}</p>
        </>
      )}
    </section>
  )
}

// Pictures: USGS impact maps of the earthquake, related NASA photographs and links to more.
// Images stay on USGS and NASA servers; each opens its source page.
function Pictures({ eventId }) {
  const [state, setState] = useState({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api
      .media(eventId)
      .then((data) => !cancelled && setState({ status: 'done', data }))
      .catch((err) => !cancelled && setState({ status: 'error', message: err.message }))
    return () => {
      cancelled = true
    }
  }, [eventId])

  const data = state.status === 'done' ? state.data : null
  const empty = data && data.images.length + data.photos.length + data.links.length === 0
  const figure = (item) => (
    <a key={item.url} className="ev-figure" href={item.page ?? item.url} target="_blank" rel="noreferrer">
      <img src={item.url} alt={item.title} loading="lazy" />
      <span className="ev-figure-title">{item.title}</span>
      <span className="ev-source-meta">
        {item.credit}
        {item.date ? ` · ${formatDay(item.date)}` : ''}
      </span>
    </a>
  )

  return (
    <section className="ev-card">
      <h3>Photos and impact maps</h3>
      {state.status === 'loading' && <p className="ev-muted">Looking for pictures…</p>}
      {state.status === 'error' && <p className="error">{state.message}</p>}
      {empty && (
        <p className="ev-muted">No pictures are linked to this event: it has no place name or hazard type to search for.</p>
      )}
      {data && data.images.length > 0 && (
        <>
          <p className="ev-muted">Impact maps for this earthquake</p>
          <div className="ev-gallery">{data.images.map(figure)}</div>
        </>
      )}
      {data && data.photos.length > 0 && (
        <>
          <p className="ev-muted">Related photos from NASA (search: “{data.photoQuery}”)</p>
          <div className="ev-gallery">{data.photos.map(figure)}</div>
        </>
      )}
      {data && data.links.length > 0 && (
        <ul className="ev-links">
          {data.links.map((link) => (
            <li key={link.url}>
              <a href={link.url} target="_blank" rel="noreferrer">{link.label}</a>
            </li>
          ))}
        </ul>
      )}
      {data && !empty && (
        <p className="ev-fine">
          {data.note} {data.credit}
        </p>
      )}
    </section>
  )
}

// A projection from this event's own NISAR time series, written on request.
function Projection({ eventId }) {
  const [state, setState] = useState({ status: 'idle' })

  const load = () => {
    setState({ status: 'loading' })
    api
      .predict(eventId)
      .then((data) => setState({ status: 'done', data }))
      .catch((err) => setState({ status: 'error', message: err.message }))
  }

  return (
    <section className="ev-card">
      <h3>What may come next</h3>
      {state.status === 'idle' && (
        <button className="button" onClick={load}>Project this event forward</button>
      )}
      {state.status === 'loading' && <p className="ev-muted">Projecting…</p>}
      {state.status === 'error' && (
        <>
          <p className="error">{state.message}</p>
          <button className="button secondary" onClick={load}>Try again</button>
        </>
      )}
      {state.status === 'done' && (
        <>
          {state.data.observations.nextExpectedAcquisition && (
            <p className="ev-text">
              Next NISAR pass expected around <strong>{formatDay(state.data.observations.nextExpectedAcquisition)}</strong>{' '}
              (it has returned about every {state.data.observations.cadenceDays} days).
            </p>
          )}
          {state.data.narrative && <p className="ev-answer">{state.data.narrative}</p>}
          {!state.data.narrative && <p className="ev-muted">{state.data.reason ?? 'There is not enough data to project yet.'}</p>}
          {state.data.metrics.length > 0 && (
            <ul className="ev-sources">
              {state.data.metrics.map((m) => (
                <li key={m.key}>
                  <span className="ev-source-name">
                    {m.product} {m.metric}: {m.direction}
                  </span>
                  <span className="ev-source-meta">
                    {m.latest.value} on {formatDay(m.latest.date)} → about {m.projected.value} ({m.projected.low} to{' '}
                    {m.projected.high}) by {formatDay(m.projected.date)} · {m.confidence} confidence
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="ev-fine">{state.data.disclaimer}</p>
        </>
      )}
    </section>
  )
}

// What else NASA has for this area (rain, soil moisture, optical imagery, terrain,
// water storage, fires). The backend stores these and the AI reads the same copy.
function RegionalContext({ eventId }) {
  const [state, setState] = useState({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api
      .context(eventId)
      .then((data) => !cancelled && setState({ status: 'done', data }))
      .catch((err) => !cancelled && setState({ status: 'error', message: err.message }))
    return () => {
      cancelled = true
    }
  }, [eventId])

  return (
    <section className="ev-card">
      <h3>Other NASA data for this area</h3>
      {state.status === 'loading' && <p className="ev-muted">Looking up datasets…</p>}
      {state.status === 'error' && <p className="error">{state.message}</p>}
      {state.status === 'done' && state.data.sources.length === 0 && (
        <p className="ev-muted">No supplementary datasets are stored for this event yet.</p>
      )}
      {state.status === 'done' && state.data.sources.length > 0 && (
        <>
          <ul className="ev-sources">
            {state.data.sources.map((s) => (
              <li key={s.source}>
                <span className="ev-source-name">{s.name}</span>
                {s.ok ? (
                  <span className="ev-source-meta">
                    {s.total} {s.measurementsRetrieved ? 'detections' : 'records'} ·{' '}
                    {s.windowStart === s.windowEnd
                      ? formatDay(s.windowStart)
                      : `${formatDay(s.windowStart)} – ${formatDay(s.windowEnd)}`}
                  </span>
                ) : (
                  <span className="ev-source-meta">unavailable right now</span>
                )}
              </li>
            ))}
          </ul>
          <p className="ev-fine">
            Most entries are catalog records showing which data exists, not measurements. The
            AI assistant can use these as background; they are not NISAR observations. Updated{' '}
            {formatDay(state.data.fetchedAt)}.
          </p>
        </>
      )}
    </section>
  )
}

function AskBox({ eventId }) {
  const { status } = useAuth()
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState([]) // { question, answer, disclaimer }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)

  const signedIn = status === 'signed-in' && !sessionExpired

  const submit = async (e) => {
    e.preventDefault()
    const text = question.trim()
    if (text.length < 3 || busy) return
    setBusy(true)
    setError('')
    try {
      const data = await api.ask(eventId, text)
      setTurns((list) => [...list, { question: text, answer: data.answer, disclaimer: data.disclaimer }])
      setQuestion('')
    } catch (err) {
      if (err.status === 401) setSessionExpired(true)
      else setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ev-card">
      <h3>Ask about this event</h3>
      {turns.map((turn, i) => (
        <div key={i} className="ev-turn">
          <p className="ev-question">{turn.question}</p>
          <p className="ev-answer">{turn.answer}</p>
          {i === turns.length - 1 && <p className="ev-fine">{turn.disclaimer}</p>}
        </div>
      ))}
      {signedIn ? (
        <form className="ev-ask" onSubmit={submit}>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What changed on the ground here?"
            minLength={3}
            maxLength={500}
            aria-label="Question"
          />
          <button type="submit" className="button" disabled={busy}>
            {busy ? 'Asking…' : 'Ask'}
          </button>
        </form>
      ) : (
        <p className="ev-muted">
          {sessionExpired ? 'Your session has ended. ' : ''}
          <Link to="/signin">Sign in</Link> to ask a question.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

function EventDetail({ eventId }) {
  const [state, setState] = useState({ status: 'loading' })
  const signedIn = useAuth().status === 'signed-in'

  useEffect(() => {
    let cancelled = false
    api
      .event(eventId)
      .then((data) => !cancelled && setState({ status: 'done', data }))
      .catch((err) => !cancelled && setState({ status: 'error', message: err.message }))
    return () => {
      cancelled = true
    }
  }, [eventId])

  if (state.status === 'loading') return <p className="ev-muted">Loading…</p>
  if (state.status === 'error') return <p className="error">{state.message}</p>

  const { event, scenes, dates, polarizations, layers } = state.data
  // The map shows signed-out visitors Japan's events only, so only offer the replay where it can open.
  const canReplayOnMap = dates.length > 1 && (signedIn || centreInJapan(event))
  const layerNames = [...new Set(layers.map((l) => l.layer))]

  return (
    <>
      <p className="ev-eyebrow">{event.type}</p>
      <h2>{event.name}</h2>
      {event.description && <p className="ev-text">{event.description}</p>}
      {canReplayOnMap && (
        // Opens the map on this event and plays its scenes from the first date.
        <Link className="button ev-replay" to={`/?event=${encodeURIComponent(event.id)}&replay=1`}>
          ▶ Replay on the map
        </Link>
      )}
      {dates.length > 1 && !canReplayOnMap && (
        <p className="ev-muted">
          <Link to="/signin">Sign in</Link> to replay this event on the map.
        </p>
      )}

      <dl className="ev-facts">
        <div>
          <dt>Area</dt>
          <dd>{event.bbox ? event.bbox.map((n) => n.toFixed(2)).join(', ') : '—'}</dd>
        </div>
        <div>
          <dt>Products</dt>
          <dd>{event.products.join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>Scenes</dt>
          <dd>{scenes.length}</dd>
        </div>
        <div>
          <dt>Passes</dt>
          <dd>
            {dates.length
              ? `${formatDay(dates[0])} – ${formatDay(dates[dates.length - 1])}`
              : '—'}
          </dd>
        </div>
        <div>
          <dt>Polarizations</dt>
          <dd>{polarizations.join(', ') || '—'}</dd>
        </div>
        <div>
          <dt>Map layers</dt>
          <dd>{layerNames.join(', ') || 'Not processed yet'}</dd>
        </div>
      </dl>

      <Pictures eventId={eventId} />
      <RegionalContext eventId={eventId} />
      <Briefing eventId={eventId} />
      <Projection eventId={eventId} />
      <AskBox eventId={eventId} />

      {scenes.length > 0 && (
        <section className="ev-card">
          <h3>Scenes</h3>
          <table className="ev-table">
            <thead>
              <tr>
                <th>Acquired</th>
                <th>Product</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {scenes.map((scene) => (
                <tr key={scene.id}>
                  <td>{formatDay(scene.acquiredAt)}</td>
                  <td>{scene.product}</td>
                  <td>{statusLabel(scene.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="ev-fine">
        NISAR data courtesy of NASA/JPL-Caltech and ISRO, distributed by ASF DAAC.
      </p>
    </>
  )
}

function Events() {
  const { eventId } = useParams()
  const [range, setRange] = useState(() => lastMonths(6)) // last 6 months until changed

  return (
    <div className="ev">
      <aside className="ev-side">
        <h1>Events</h1>
        <DateRange value={range} onChange={setRange} allowAll label="Show events from" />
        <EventList selectedId={eventId} range={range} />
      </aside>
      <section className="ev-main">
        {eventId ? (
          // The key resets the detail, briefing and question box per event.
          <EventDetail key={eventId} eventId={eventId} />
        ) : (
          <p className="ev-muted">Pick an event to see what NISAR has for it.</p>
        )}
      </section>
    </div>
  )
}

export default Events
