import { useState } from 'react'
import { isoDay, lastMonths, setRangeEnd, sinceLaunch, NISAR_LAUNCH } from './explore.js'
import './DateRange.css'

// Pick a period: quick choices plus exact From / To dates. Used by the map's area search
// (at most `maxSpan` days, because the backend refuses longer searches) and by the Events list.
const PRESETS = [
  { label: '1 month', months: 1 },
  { label: '3 months', months: 3 },
  { label: '6 months', months: 6 },
  { label: '1 year', months: 12 },
]

function DateRange({ value, onChange, maxSpan, allowAll = false, label = 'Period' }) {
  const [now] = useState(Date.now)
  const today = isoDay(now)
  const choices = PRESETS.map((p) => ({ label: p.label, range: lastMonths(p.months, now) }))
  if (allowAll) choices.push({ label: 'All', range: sinceLaunch(now) })
  const same = (r) => r.start === value.start && r.end === value.end

  const edit = (key) => (e) => {
    if (e.target.value) onChange(setRangeEnd(value, key, e.target.value, { maxSpan, now }))
  }

  return (
    <div className="dr" role="group" aria-label={label}>
      <div className="dr-chips">
        {choices.map((c) => (
          <button
            key={c.label}
            type="button"
            className={`dr-chip${same(c.range) ? ' dr-chip-on' : ''}`}
            aria-pressed={same(c.range)}
            onClick={() => onChange(c.range)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="dr-fields">
        <label>
          From
          <input type="date" value={value.start} min={NISAR_LAUNCH} max={today} onChange={edit('start')} />
        </label>
        <label>
          To
          <input type="date" value={value.end} min={NISAR_LAUNCH} max={today} onChange={edit('end')} />
        </label>
      </div>
    </div>
  )
}

export default DateRange
