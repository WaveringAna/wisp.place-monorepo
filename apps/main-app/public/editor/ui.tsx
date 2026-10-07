import {
	type ButtonHTMLAttributes,
	type InputHTMLAttributes,
	type KeyboardEvent,
	type ReactNode,
	type SelectHTMLAttributes,
	useEffect,
	useId,
	useRef,
	useState,
} from 'react'
import { isTypingTarget, type RowProps } from './keys'
import { notify } from './store'

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')

const Spinner = () => (
	<span className="spin" aria-hidden="true">
		◐
	</span>
)

export const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>

type Tone = 'pink' | 'lilac' | 'mint' | 'butter'

export const Tag = ({ tone, children }: { tone?: Tone; children: ReactNode }) => (
	<span className={cx('tag', tone && `tag-${tone}`)}>{children}</span>
)

type StatusTone = 'ok' | 'warn' | 'bad' | 'muted' | 'lock'

/** A state as a glyph and a word, like `✓ live`: the colour helps, the word carries it. */
export const Status = ({ tone, children }: { tone: StatusTone; children: ReactNode }) => (
	<span className={cx('st', `st-${tone}`)}>{children}</span>
)

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: 'default' | 'primary' | 'ghost' | 'danger'
	busy?: boolean
	/** Key shown beside the label; the list that owns the button handles it. */
	shortcut?: string
	/** Key shown beside the label that presses the button from anywhere in its tab. */
	hotkey?: string
}

export function Button({
	variant = 'default',
	busy = false,
	shortcut,
	hotkey,
	className,
	children,
	disabled,
	type = 'button',
	...props
}: ButtonProps) {
	const key = hotkey ?? shortcut
	return (
		<button
			{...props}
			data-hotkey={hotkey}
			type={type}
			className={cx('btn', variant !== 'default' && `btn-${variant}`, className)}
			disabled={disabled || busy}
			aria-busy={busy || undefined}
		>
			{busy && <Spinner />}
			{children}
			{key && <Kbd>{key}</Kbd>}
		</button>
	)
}

export const openInNewTab = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')

/** External link that always opens in a new tab without handing the page an opener. */
export const ExternalLink = ({
	href,
	children,
	className,
}: {
	href: string
	children: ReactNode
	className?: string
}) => (
	<a href={href} target="_blank" rel="noopener noreferrer" className={className}>
		{children} <span aria-hidden="true">↗</span>
	</a>
)

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
	<input {...props} className={cx('input', className)} />
)

interface FieldProps {
	label: ReactNode
	hint?: ReactNode
	/** Classes for the whole field (label, control and hint), usually width or spacing. */
	className?: string
}

const FieldText = ({ label, hint, children }: Omit<FieldProps, 'className'> & { children: ReactNode }) => (
	<>
		<span className="field-label">{label}</span>
		{children}
		{hint && <span className="hint mt-1 block">{hint}</span>}
	</>
)

interface TextFieldProps extends FieldProps, Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
	/** Fixed text shown inside the right edge of the input, like a domain suffix. */
	suffix?: string
	/** Label beside the input instead of above it, for a form that sits on one row. */
	inline?: boolean
}

/** Label for the form on a list's last row: a rose `+` before the words. */
export const AddLabel = ({ children }: { children: string }) => (
	<>
		<span className="text-rose" aria-hidden="true">
			+
		</span>{' '}
		{children}
	</>
)

/** A labelled input; the label wraps the control so the two are linked without ids. */
export const TextField = ({ label, hint, className, suffix, inline = false, ...input }: TextFieldProps) => (
	<label className={cx(inline ? 'field-inline' : 'block', className)}>
		<FieldText label={label} hint={hint}>
			<span className="relative block">
				<input {...input} className={cx('input', suffix && 'pr-28')} />
				{suffix && (
					<span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-soft">{suffix}</span>
				)}
			</span>
		</FieldText>
	</label>
)

type SelectFieldProps = FieldProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'>

export const SelectField = ({ label, hint, className, ...select }: SelectFieldProps) => (
	<label className={cx('block', className)}>
		<FieldText label={label} hint={hint}>
			<select {...select} className="input" />
		</FieldText>
	</label>
)

interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
	type?: 'checkbox' | 'radio'
	label: ReactNode
	hint?: ReactNode
}

/** Checkbox or radio drawn as `[x]` / `(•)`; the native input keeps keyboard and form behaviour. */
export const Toggle = ({ type = 'checkbox', label, hint, className, ...input }: ToggleProps) => (
	<label className={cx('toggle', className)}>
		<input {...input} type={type} />
		<span className="glyph" aria-hidden="true" />
		<span>
			{label}
			{hint && <span className="hint block">{hint}</span>}
		</span>
	</label>
)

interface SegmentedProps<T extends string> {
	label: string
	options: readonly { value: T; label: string }[]
	value: T | null
	onChange: (value: T) => void
	disabled?: boolean
}

export function Segmented<T extends string>({ label, options, value, onChange, disabled }: SegmentedProps<T>) {
	const name = useId()
	return (
		<fieldset className="segmented" disabled={disabled}>
			<legend className="sr-only">{label}</legend>
			{options.map((option) => (
				<label key={option.value}>
					<input
						type="radio"
						name={name}
						value={option.value}
						checked={value === option.value}
						onChange={() => onChange(option.value)}
					/>
					{option.label}
				</label>
			))}
		</fieldset>
	)
}

interface SectionProps {
	title: string
	meta?: ReactNode
	actions?: ReactNode
	children: ReactNode
}

export function Section({ title, meta, actions, children }: SectionProps) {
	const id = useId()
	return (
		<section aria-labelledby={id} className="mb-12">
			{/* Tall enough for a button, so every section's heading sits at the same height with or without actions. */}
			<header className="mb-3 flex min-h-[2.875rem] flex-wrap items-center gap-x-3 gap-y-2 border-b-2 border-dashed border-rule pb-2">
				<h2 id={id} className="font-bold">
					<span className="text-rose" aria-hidden="true">
						#{' '}
					</span>
					{title}
				</h2>
				{meta && <span className="text-xs text-ink-soft">{meta}</span>}
				{actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
			</header>
			{children}
		</section>
	)
}

/** Empty state in the landing page's handwriting, kept to one line. */
export const Empty = ({ children }: { children: ReactNode }) => (
	<p className="py-6 text-center font-hand text-xl text-ink-soft">{children}</p>
)

const SKELETON_ROWS = ['a', 'b', 'c', 'd'] as const

export const SkeletonRows = ({ count = 3 }: { count?: number }) => (
	<div className="sheet" role="status" aria-label="loading">
		{SKELETON_ROWS.slice(0, count).map((row) => (
			<div key={row} className="flex items-center gap-4 border-t border-rule/70 px-4 py-3.5 first:border-0">
				<span className="skeleton h-3.5 w-40" />
				<span className="skeleton h-3.5 w-64 max-sm:hidden" />
				<span className="skeleton ml-auto h-3.5 w-14" />
			</div>
		))}
	</div>
)

export interface Column {
	name: string
	/** The header text, when it is not just the name. */
	label?: ReactNode
	/** Numbers and dates sit on the right. */
	align?: 'left' | 'right'
	/** Classes for the header cell, usually a width or `max-sm:hidden`. */
	className?: string
	/** Set on the column the sheet is sorted by. */
	sort?: 'ascending' | 'descending'
}

/** The chevron column of a sheet whose rows expand. */
export const CHEVRON: Column = { name: 'chevron', label: '', className: 'chev' }

interface SheetProps {
	columns: readonly Column[]
	children: ReactNode
	/** A form on the sheet's last line that adds to it. */
	form?: ReactNode
	foot?: ReactNode
}

/** One outlined table: a header row names the columns, the rows are the list. */
export const Sheet = ({ columns, children, form, foot }: SheetProps) => (
	<div className="sheet">
		<table>
			<thead>
				<tr>
					{columns.map((column) => (
						<th
							key={column.name}
							scope="col"
							aria-sort={column.sort}
							className={cx(column.align === 'right' && 'num', column.className)}
						>
							{column.label ?? column.name}
						</th>
					))}
				</tr>
			</thead>
			<tbody>{children}</tbody>
		</table>
		{form && <div className="row-form">{form}</div>}
		{foot && <div className="sheet-foot">{foot}</div>}
	</div>
)

interface RowOwnProps {
	rowProps: RowProps
	/** What enter, space or a click on the row does. Buttons inside the row keep their own clicks. */
	onActivate: () => void
	expanded?: boolean
	/** The id of the detail row an expandable row controls. */
	controls?: string
	children: ReactNode
}

/** A sheet row the keyboard can land on: j/k move between rows, enter activates, letters go to the list. */
export function Row({ rowProps, onActivate, expanded, controls, children }: RowOwnProps) {
	const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
		if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
			event.preventDefault()
			onActivate()
			return
		}
		if (!isTypingTarget(event.target)) rowProps.onKeyDown(event)
	}
	return (
		<tr
			{...rowProps}
			className="row"
			aria-expanded={expanded}
			aria-controls={controls}
			onClick={(event) => {
				if (!(event.target instanceof Element && event.target.closest('button, a, input'))) onActivate()
			}}
			onKeyDown={onKeyDown}
		>
			{children}
		</tr>
	)
}

/** The row under an expanded one, holding its details against a hairline. */
export const DetailRow = ({ id, span, children }: { id: string; span: number; children: ReactNode }) => (
	<tr className="detail">
		<td id={id} colSpan={span}>
			<div className="detail-box">{children}</div>
		</td>
	</tr>
)

/** Buttons in a row's last cell: the mouse way to what the row's keys do, so they stay out of the tab order. */
export const RowActions = ({ children }: { children: ReactNode }) => <td className="acts">{children}</td>

/** A number and its label for the strip above a list. */
export const Stat = ({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) => (
	<div className="stat">
		<div className="stat-label">{label}</div>
		<div className="stat-value">
			{value}
			{note && <small>{note}</small>}
		</div>
	</div>
)

export const Notice = ({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode }) => (
	<div
		role={tone === 'bad' ? 'alert' : 'status'}
		className={cx(
			'my-2 border-l-2 py-1 pl-3 text-xs',
			tone === 'info' && 'border-rose text-ink-soft',
			tone === 'warn' && 'border-warn text-warn',
			tone === 'bad' && 'border-bad text-bad',
		)}
	>
		{children}
	</div>
)

/** A terminal, with a title strip and a copy button when it has a title. */
export const CodeBlock = ({ code, title }: { code: string; title?: string }) => (
	<div className="terminal">
		{title && (
			<div className="terminal-head">
				{title}
				<CopyButton text={code} />
			</div>
		)}
		<pre className="overflow-x-auto p-4 text-[0.8rem] leading-relaxed">
			<code>{code}</code>
		</pre>
	</div>
)

export function CopyButton({ text, label = 'copy' }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false)

	useEffect(() => {
		if (!copied) return
		const timer = setTimeout(() => setCopied(false), 1500)
		return () => clearTimeout(timer)
	}, [copied])

	const copy = () =>
		navigator.clipboard.writeText(text).then(
			() => setCopied(true),
			() => notify.error('could not reach the clipboard, select the text instead'),
		)

	return (
		<Button variant="ghost" onClick={copy} aria-label={`${label} ${text}`}>
			{copied ? 'copied ✓' : label}
		</Button>
	)
}

// Controls ↑/↓ steps between, every radio option included.
const CONTROLS =
	'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]):not([tabindex="-1"]), a[href]'

/**
 * ↑ and ↓ move focus through a dialog's controls the way j/k move through rows,
 * one radio option at a time. Moving never changes a choice: space or enter picks
 * the focused radio (enter would otherwise submit the form), ← and → still work.
 * Selects and textareas keep their own arrow keys.
 */
const onDialogKey = (event: KeyboardEvent<HTMLDialogElement>) => {
	if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
	const target = event.target
	if (event.key === 'Enter' && target instanceof HTMLInputElement && target.type === 'radio') {
		event.preventDefault()
		target.click()
		return
	}
	if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
	if (target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) return
	const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(CONTROLS)]
	const index = controls.indexOf(target as HTMLElement)
	const next = controls[index + (event.key === 'ArrowDown' ? 1 : -1)]
	event.preventDefault()
	next?.focus()
}

interface DialogProps {
	open: boolean
	onClose: () => void
	title: string
	children: ReactNode
	footer?: ReactNode
}

/**
 * Native modal dialog: the browser handles the focus trap, Esc, inertness of
 * the page behind it, and returning focus on close. Content only mounts while
 * open, so forms inside start fresh every time.
 */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
	const ref = useRef<HTMLDialogElement>(null)
	const titleId = useId()

	useEffect(() => {
		const dialog = ref.current
		if (!dialog) return
		if (open && !dialog.open) {
			dialog.showModal()
			// Without a marked control the browser would focus the mouse-only close button; the body
			// takes focus instead, so the first ↓ lands on the first control once the content has loaded.
			;(
				dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog.querySelector<HTMLElement>('[data-dialog-body]')
			)?.focus()
		}
		if (!open && dialog.open) dialog.close()
	}, [open])

	return (
		<dialog
			ref={ref}
			className="dialog"
			aria-labelledby={titleId}
			onKeyDown={onDialogKey}
			onCancel={(event) => {
				event.preventDefault()
				onClose()
			}}
		>
			{open && (
				<>
					<header className="flex items-center gap-3 border-b-2 border-line bg-lilac px-4 py-2 text-on-pastel">
						<h2 id={titleId} className="font-bold">
							{title}
						</h2>
						{/* Mouse affordance only: Esc and every footer's cancel button cover the keyboard. */}
						<button
							type="button"
							tabIndex={-1}
							onClick={onClose}
							className="ml-auto text-xs opacity-70 hover:opacity-100"
						>
							esc ✕
						</button>
					</header>
					<div data-dialog-body tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 outline-none">
						{children}
					</div>
					{footer && (
						<footer className="flex flex-wrap items-center gap-2 border-t border-dashed border-rule px-5 py-3">
							{footer}
						</footer>
					)}
				</>
			)}
		</dialog>
	)
}
