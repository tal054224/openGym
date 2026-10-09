import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { Button, NumberField, Segmented, SelectRow, TextArea, TextField } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import LineChart from '../components/LineChart.jsx'
import { confirmSheet } from '../sheets.jsx'
import { fmtDate, fmtNum, todayISO } from '../lib/format.js'
import { dateLocale, t } from '../lib/i18n.js'
import { createFood, deleteFood, foodSummary, listFood, updateFood, saveFoodGoals, groupMeals, totalsOf, goalProgress } from '../lib/food.js'

const MEALS = [
  { value: 'breakfast', label: () => t('Breakfast') }, { value: 'lunch', label: () => t('Lunch') },
  { value: 'dinner', label: () => t('Dinner') }, { value: 'snack', label: () => t('Snack') }
]
const MACROS = [
  { key: 'calories', label: () => t('Calories'), unit: 'kcal', color: 'var(--orange)' },
  { key: 'protein_g', label: () => t('Protein'), unit: 'g', color: 'var(--blue)' },
  { key: 'carbs_g', label: () => t('Carbs'), unit: 'g', color: 'var(--green)' },
  { key: 'fat_g', label: () => t('Fat'), unit: 'g', color: 'var(--yellow)' }
]
const blankDraft = day => ({ date: day, time: '', meal: 'breakfast', name: '', quantity: null, unit: 'g', calories: null, protein_g: null, carbs_g: null, fat_g: null, notes: '' })
const shiftDay = (iso, by) => {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() + by)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const idempotencyKey = () => globalThis.crypto?.randomUUID?.() || `food-${Date.now()}-${Math.random().toString(36).slice(2)}`
function MacroProgress({ totals, goals }) {
  return <div className="food-macro-list">
    {MACROS.map(({ key, label, unit, color }) => {
      const p = goalProgress(totals[key], goals?.[key])
      return <div className="food-macro" key={key}>
        <div className="row between food-macro-head">
          <span>{label()}</span>
          <strong>{fmtNum(p.total)}{p.goal ? ` / ${fmtNum(p.goal)}` : ''} <i>{unit}</i></strong>
        </div>
        {p.goal && <div className="food-track"><span style={{ width: `${p.fraction * 100}%`, background: p.exceeded ? 'var(--red)' : color }} /></div>}
      </div>
    })}
  </div>
}

function GoalEditor({ goals, onSave, saving }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(MACROS.map(m => [m.key, goals?.[m.key] ?? null])))
  useEffect(() => setDraft(Object.fromEntries(MACROS.map(m => [m.key, goals?.[m.key] ?? null]))), [goals])
  return <div className="food-goal-editor">
    {MACROS.map(({ key, label, unit }) => <label className="food-goal-field" key={key}>
      <span>{label()} <i>{unit}</i></span>
      <NumberField value={draft[key]} nullable onChange={v => setDraft(d => ({ ...d, [key]: v }))} aria-label={label()} />
    </label>)}
    <Button variant="primary" icon="check" disabled={saving} onClick={() => onSave(draft)}>{t('Save')}</Button>
  </div>
}

function FoodForm({ draft, setDraft, editing, onSave, onCancel, saving }) {
  const set = key => value => setDraft(d => ({ ...d, [key]: value }))
  const units = ['', 'g', 'ml', 'piece', 'serving', 'cup', 'tbsp', 'tsp', 'oz'].map(value => ({ value, label: value || t('None') }))
  return <section className="card food-form" aria-label={editing ? t('Edit') : t('Log')}>
    <div className="row between"><h2>{editing ? t('Edit') : t('Log')}</h2><button className="iconbtn sm" onClick={onCancel} aria-label={t('Cancel')}><Icon name="xmark" /></button></div>
    <label className="food-field"><span>{t('Food name')}</span><TextField autoFocus maxLength={120} value={draft.name} onChange={e => set('name')(e.target.value)} /></label>
    <div className="food-field"><Segmented className="food-meals" value={draft.meal} onChange={set('meal')} options={MEALS.map(({ value, label }) => ({ value, label: label() }))} /></div>
    <div className="food-form-pair">
      <label className="food-field"><span>{t('Date')}</span><TextField type="date" value={draft.date} onChange={e => set('date')(e.target.value)} /></label>
      <label className="food-field"><span>{t('Time')}</span><TextField type="time" value={draft.time} onChange={e => set('time')(e.target.value)} /></label>
    </div>
    <div className="food-form-pair">
      <label className="food-field"><span>{t('Quantity')}</span><NumberField nullable value={draft.quantity} onChange={set('quantity')} /></label>
      <div className="food-field"><span>{t('Unit')}</span><SelectRow title={t('Unit')} value={draft.unit || ''} options={units} onChange={set('unit')} /></div>
    </div>
    <div className="food-macro-inputs">
        {MACROS.map(({ key, label, unit }) => <label className="food-field" key={key}>
          <span>{label()} <i>{unit}</i></span>
        <NumberField nullable value={draft[key]} onChange={set(key)} />
      </label>)}
    </div>
    <label className="food-field"><span>{t('Notes')}</span><TextArea maxLength={500} rows={2} value={draft.notes} onChange={e => set('notes')(e.target.value)} /></label>
    <div className="row food-form-actions">
      <Button variant="primary" icon="check" disabled={saving} onClick={onSave}>{t('Save')}</Button>
      <Button onClick={onCancel}>{t('Cancel')}</Button>
    </div>
  </section>
}

export default function Food() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const toast = useUI(s => s.toast)
  const [day, setDay] = useState(todayISO())
  const [items, setItems] = useState([])
  const [summary, setSummary] = useState(null)
  const [draft, setDraft] = useState(null)
  const [editing, setEditing] = useState(null)
  const [goalsOpen, setGoalsOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const weekFrom = shiftDay(day, -6)
  useEffect(() => {
    if (!user) return
    let current = true
    setLoading(true)
    setError('')
    Promise.all([listFood({ from: day, to: day }), foodSummary({ from: weekFrom, to: day })])
      .then(([list, totals]) => {
        if (!current) return
        setItems(list.items || [])
        setSummary(totals)
      })
      .catch(() => { if (current) setError(t('Something went wrong')) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [user?.id, day, weekFrom])

  const totals = useMemo(() => totalsOf(items), [items])
  const goals = summary?.goals || null
  const points = useMemo(() => (summary?.days || []).map(d => ({ t: new Date(d.date + 'T12:00:00').getTime(), y: d.calories, d: d.date })), [summary])
  const groups = useMemo(() => groupMeals(items), [items])
  if (!user) return <div className="narrow"><div className="hdr"><h1>{t('Nutrition')}</h1><button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button></div><div className="card empty">{t('Sign in')}</div></div>

  const reload = async () => {
    const [list, report] = await Promise.all([listFood({ from: day, to: day }), foodSummary({ from: weekFrom, to: day })])
    setItems(list.items || [])
    setSummary(report)
  }
  const startNew = () => { setEditing(null); setDraft(blankDraft(day)) }
  const startEdit = item => {
    setEditing(item)
    setDraft({ ...blankDraft(day), ...item, time: item.time || '', notes: item.notes || '' })
  }
  const closeForm = () => { setDraft(null); setEditing(null) }
  const save = async () => {
    if (!draft.name.trim()) { toast(t('Food name')); return }
    const payload = {
      date: draft.date, meal: draft.meal, name: draft.name.trim(),
      time: draft.time || null, quantity: draft.quantity ?? null, unit: draft.unit || null,
      ...Object.fromEntries(MACROS.map(m => [m.key, draft[m.key] ?? null])),
      notes: draft.notes.trim() || null
    }
    setSaving(true)
    try {
      if (editing) await updateFood(editing.id, { ...payload, version: editing.version })
      else await createFood({ ...payload, idempotency_key: idempotencyKey() })
      closeForm()
      await reload()
      toast(t('Saved'))
    } catch {
      toast(t('Something went wrong'))
    } finally { setSaving(false) }
  }
  const remove = async item => {
    try { await deleteFood(item.id, item.version); await reload(); toast(t('Saved')) }
    catch { toast(t('Something went wrong')) }
  }
  const saveGoals = async next => {
    setSaving(true)
    try { const res = await saveFoodGoals(next); setSummary(s => ({ ...s, goals: res.goals })); setGoalsOpen(false); toast(t('Saved')) }
    catch { toast(t('Something went wrong')) }
    finally { setSaving(false) }
  }
  const setDayOffset = n => setDay(d => shiftDay(d, n))

  return <div className="narrow food-page">
    <div className="hdr">
      <div><h1>{t('Nutrition')}</h1><div className="sub">{new Date(day + 'T12:00:00').toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
    </div>

    <section className="card food-daily">
      <div className="row between food-daily-head">
        <h2>{fmtDate(day, true)}</h2>
        <div className="row food-day-nav">
          <button className="iconbtn sm" onClick={() => setDayOffset(-1)} aria-label={t('Previous')}><Icon name="chevronLeft" /></button>
          <button className="iconbtn sm" onClick={() => setDay(todayISO())} disabled={day === todayISO()}>{t('Today')}</button>
          <button className="iconbtn sm" onClick={() => setDayOffset(1)} disabled={day >= todayISO()} aria-label={t('Next')}><Icon name="chevronRight" /></button>
        </div>
      </div>
      <MacroProgress totals={totals} goals={goals} />
      <div className="row between food-goal-row">
        <span className="small muted">{totals.entries}</span>
        <Button size="sm" variant="ghost" icon="target" onClick={() => setGoalsOpen(v => !v)}>{t('Goal')}</Button>
      </div>
      {goalsOpen && <GoalEditor goals={goals} onSave={saveGoals} saving={saving} />}
    </section>

    <section className="card food-weekly">
      <div className="row between"><h2>7d</h2><span className="small muted">kcal</span></div>
      <LineChart points={points} h={110} unit="kcal" color="var(--orange)" />
      {!points.length && <div className="small muted food-week-average">{t('No data yet')}</div>}
    </section>

    <div className="row between food-list-heading"><h2>{t('Log')}</h2><Button size="sm" variant="primary" icon="plus" onClick={startNew}>{t('Log')}</Button></div>
    {draft && <FoodForm draft={draft} setDraft={setDraft} editing={editing} onSave={save} onCancel={closeForm} saving={saving} />}
    {error && <div className="card food-error" role="alert">{error} <Button size="sm" onClick={() => window.location.reload()}>{t('Try again')}</Button></div>}
    {loading ? <div className="card muted small">{t('Loading…')}</div>
      : groups.length ? groups.map(group => <section className="food-meal-group" key={group.meal}>
        <h3>{MEALS.find(m => m.value === group.meal)?.label()}</h3>
        <div className="sect-b">{group.entries.map(item => <article className="food-entry" key={item.id}>
          <div className="food-entry-main">
            <div className="food-entry-title"><strong>{item.name}</strong>{item.time && <span className="small muted">{item.time}</span>}</div>
            <div className="small muted">{item.quantity != null ? `${fmtNum(item.quantity)} ${item.unit || ''}`.trim() : ''}{item.notes ? `${item.quantity != null ? ' · ' : ''}${item.notes}` : ''}</div>
            <div className="food-entry-macros">{MACROS.map(m => item[m.key] != null && <span key={m.key}>{m.key === 'calories' ? fmtNum(item[m.key]) + ' kcal' : `${m.label()} ${fmtNum(item[m.key])}g`}</span>)}</div>
          </div>
          <div className="row food-entry-actions">
            <button className="iconbtn sm" onClick={() => startEdit(item)} aria-label={t('Edit')}><Icon name="pencil" /></button>
            <button className="iconbtn sm" onClick={() => confirmSheet({ title: t('Delete'), message: item.name, confirmText: t('Delete'), danger: true, onConfirm: () => remove(item) })} aria-label={t('Delete')}><Icon name="trash" /></button>
          </div>
        </article>)}</div>
      </section>)
        : <div className="card empty"><div className="ico"><Icon name="chartLine" /></div>{t('No data yet')}</div>}
  </div>
}
