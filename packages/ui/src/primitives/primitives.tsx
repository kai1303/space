import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, CaretDown, X } from "@phosphor-icons/react";
import { AnimatePresence, motion, useAnimate, useIsPresent, useReducedMotion } from "motion/react";
import { motionTransition, surfaceMotion } from "../motion/motion.js";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: React.Ref<HTMLButtonElement>;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
};
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className = "",
  children,
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`sp-button sp-button--${variant} sp-button--${size} ${className}`}
    >
      {loading && <span className="sp-spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
export function IconButton({
  label,
  children,
  className = "",
  ...props
}: Omit<ButtonProps, "children"> & { label: string; children: ReactNode }) {
  return (
    <Button
      {...props}
      variant={props.variant ?? "ghost"}
      className={`sp-icon-button ${className}`}
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}
export type Tone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info";
export function Badge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  return (
    <span className={`sp-badge sp-tone--${tone}`}>
      {dot && <span className="sp-status-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
export function Avatar({
  name,
  initials,
  image,
  size = "md",
  tone = "purple",
  presence,
}: {
  name: string;
  initials: string;
  image?: string | null;
  size?: "sm" | "md" | "lg";
  tone?: "purple" | "blue" | "green" | "orange";
  presence?: "online" | "away" | "offline";
}) {
  return (
    <span
      className={`sp-avatar sp-avatar--${size} sp-avatar--${tone}`}
      role="img"
      aria-label={`${name}${presence ? `, ${presence}` : ""}`}
    >
      <span aria-hidden="true">{initials}</span>
      {image && <img key={image} src={image} alt="" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }} onError={event => { event.currentTarget.hidden = true; }} />}
      {presence && <span className={`sp-presence sp-presence--${presence}`} />}
    </span>
  );
}
export function TextField({
  label,
  hint,
  error,
  id: providedId,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const description = error || hint;
  return (
    <div className={`sp-field ${className}`}>
      <label htmlFor={id}>{label}</label>
      <input
        {...props}
        id={id}
        className="sp-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={
          description ? `${id}-description` : props["aria-describedby"]
        }
      />
      {description && (
        <span
          id={`${id}-description`}
          className={error ? "sp-field-error" : "sp-field-hint"}
        >
          {description}
        </span>
      )}
    </div>
  );
}
export function Switch({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="sp-switch-row"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span>{label}</span>
      <span className="sp-switch-track">
        <span className="sp-switch-thumb">
          {checked && <Check size={10} weight="bold" />}
        </span>
      </span>
    </button>
  );
}
export type TabItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  panelId?: string;
};
export function Tabs({
  className = "",
  items,
  value,
  onChange,
  label,
}: {
  className?: string;
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const indicatorId = useId();
  const reduced = useReducedMotion();
  return (
    <div className={`sp-tabs ${className}`.trim()} role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(node) => {
            if (node) refs.current.set(item.id, node);
            else refs.current.delete(item.id);
          }}
          type="button"
          role="tab"
          aria-selected={item.id === value}
          aria-controls={item.panelId}
          tabIndex={item.id === value ? 0 : -1}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => {
            const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
            if (!keys.includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      items.length) %
                    items.length;
            const target = items[next];
            if (target) {
              onChange(target.id);
              refs.current.get(target.id)?.focus();
            }
          }}
        >
          {item.icon}
          {item.label}
          {item.id === value && (
            <motion.span
              aria-hidden="true"
              className="sp-tab-indicator"
              layoutId={indicatorId}
              transition={motionTransition(reduced)}
            />
          )}
        </button>
      ))}
    </div>
  );
}
export function Menu({ label, items, trigger, className = "", menuLabel = label, floating = false, align = "end" }: {
  label: string;
  trigger?: ReactNode;
  className?: string;
  menuLabel?: string;
  floating?: boolean;
  align?: "start" | "end";
  items: { label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; separatorBefore?: boolean }[];
}) {
  return <Popover label={label} panelLabel={menuLabel} role="menu" className={`sp-menu ${className}`}
    panelClassName={`sp-menu-content ${className ? `${className}-content` : ""}`}
    triggerClassName="sp-button sp-button--secondary sp-button--md" floating={floating} align={align}
    trigger={trigger ?? <>{label}<CaretDown size={14} /></>}>
    {close => items.map(item => <span key={item.label} className="sp-menu-item-group">
      {item.separatorBefore && <hr role="separator" />}
      <button type="button" role="menuitem" className={item.danger ? "sp-menu-danger" : ""} onClick={() => { item.onSelect(); close(); }}>{item.icon}{item.label}</button>
    </span>)}
  </Popover>;
}

export function Popover({ label, trigger, children, className = "", panelClassName = "", triggerClassName, panelLabel = label, role, floating = false, align = "end", disabled = false }: {
  label: string;
  trigger: ReactNode;
  children: (close: (restoreFocus?: boolean) => void) => ReactNode;
  className?: string;
  panelClassName?: string;
  triggerClassName?: string;
  panelLabel?: string;
  role?: "menu";
  floating?: boolean;
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const reduced = useReducedMotion();
  function show() { if (!disabled) { setExpanded(true); setOpen(true); } }
  const [position, setPosition] = useState({ top: 0, left: 0 });
  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) ref.current?.querySelector("summary")?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (!ref.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("focusin", close); };
  }, [open]);
  useLayoutEffect(() => { if (disabled) close(); }, [disabled]);
  useLayoutEffect(() => {
    if (!open || !floating) return;
    const place = () => {
      const anchor = ref.current?.getBoundingClientRect(), menu = panel.current?.getBoundingClientRect();
      if (!anchor || !menu) return;
      // Animation scales the visual bounds; anchor against stable layout dimensions.
      const width = panel.current!.offsetWidth || menu.width, height = panel.current!.offsetHeight || menu.height;
      const top = anchor.bottom + height + 6 > window.innerHeight ? anchor.top - height - 6 : anchor.bottom + 6;
      setPosition({
        left: Math.max(8, Math.min(align === "start" ? anchor.left : anchor.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(top, window.innerHeight - height - 8)),
      });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (panel.current) observer?.observe(panel.current);
    if (ref.current) observer?.observe(ref.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, floating, align]);
  function navigate(event: React.KeyboardEvent) {
    if (disabled || event.defaultPrevented) return;
    if (event.key === "Escape") { if (open) { event.preventDefault(); event.stopPropagation(); close(true); } return; }
    if (event.key === "Tab") { if (open && role === "menu") { event.stopPropagation(); close(true); } return; }
    if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')) return;
    if (role !== "menu" && event.target !== ref.current?.querySelector('summary')) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    show();
    requestAnimationFrame(() => {
      const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])].filter(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true' && !button.closest('[hidden],[inert]'));
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowUp" ? (current < 0 ? buttons.length - 1 : (current - 1 + buttons.length) % buttons.length) : (current + 1) % buttons.length;
      buttons[next]?.focus();
    });
  }
  const content = <AnimatePresence onExitComplete={() => setExpanded(false)}>
    {open && <PopoverPanel key={id} panelRef={panel} id={id} role={role} aria-label={panelLabel} className={panelClassName} data-floating={floating || undefined}
      style={{ ...(floating ? { position: "fixed", ...position, right: "auto", bottom: "auto", zIndex: 100 } : {}), transformOrigin: "center" }} onKeyDown={navigate} {...surfaceMotion(reduced)}>
      {children((restoreFocus = true) => close(restoreFocus))}
    </PopoverPanel>}
  </AnimatePresence>;
  return (
    <details
      ref={ref}
      open={expanded}
      className={className}
      onKeyDown={navigate}
    >
      <summary role="button" className={triggerClassName} aria-label={label} aria-haspopup={role} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined} aria-expanded={open} aria-controls={id} onClick={event => { event.preventDefault(); if (open) close(); else show(); }}>
        {trigger}
      </summary>
      {floating ? createPortal(content, ref.current?.closest("dialog") ?? document.body) : content}
    </details>
  );
}
function PopoverPanel({ panelRef, ...props }: React.ComponentProps<typeof motion.div> & { panelRef: React.Ref<HTMLDivElement> }) {
  const present = useIsPresent();
  return <motion.div {...props} data-sp-popover-panel ref={panelRef} inert={!present} aria-hidden={!present || undefined} />;
}

export function SidePanel({ children, className, role, hidden, ref, "aria-label": label }: {
  ref?: React.Ref<HTMLElement>;
  children: ReactNode;
  className: string;
  role?: "region" | "dialog";
  hidden?: boolean;
  "aria-label"?: string;
}) {
  const reduced = useReducedMotion();
  const present = useIsPresent();
  const [collapsed, setCollapsed] = useState(!!hidden);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  useLayoutEffect(() => { if (!hidden) setCollapsed(false); }, [hidden]);
  const visibilityMotion = surfaceMotion(reduced, "right");
  return <motion.aside
    ref={ref} tabIndex={-1} role={role} className={className} aria-label={label}
    hidden={hidden && collapsed} aria-hidden={hidden || !present || undefined} inert={hidden || !present}
    {...visibilityMotion}
    initial={hidden ? false : visibilityMotion.initial}
    animate={hidden ? visibilityMotion.exit : visibilityMotion.animate}
    onAnimationComplete={() => { if (hiddenRef.current) setCollapsed(true); }}
  >{children}</motion.aside>;
}

export function Dialog({
  open,
  onClose,
  onBeforeClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onBeforeClose?: () => boolean;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const [ref, animate] = useAnimate<HTMLDialogElement>();
  const reduced = useReducedMotion();
  const id = useId();
  const [closing, setClosing] = useState(false);
  useEffect(() => { if (!open) setClosing(false); }, [open]);
  function requestClose() {
    if (!closing && onBeforeClose?.() !== false) setClosing(true);
  }
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    let active = true;
    const visible = open && !closing;
    const entering = visible && !dialog.open;
    if (entering) dialog.showModal();
    if (!dialog.open) return;
    const preset = surfaceMotion(reduced, "modal");
    const animation = animate(dialog, {
      opacity: visible ? (entering ? [0, 1] : 1) : 0,
      scale: visible ? (entering ? [preset.initial.scale!, 1] : 1) : preset.exit.scale!,
      y: visible ? (entering ? [preset.initial.y!, 0] : 0) : preset.exit.y!,
      "--sp-dialog-backdrop-opacity": visible ? (entering ? [0, 1] : 1) : 0,
    }, motionTransition(reduced));
    if (!visible) void animation.then(() => {
      if (!active) return;
      if (dialog.open) dialog.close();
    });
    return () => { active = false; animation.stop(); };
  }, [open, closing, animate, reduced]);
  return (
    <dialog
      ref={ref}
      className="sp-dialog"
      inert={closing || !open}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onClose={onClose}
      onCancel={event => { event.preventDefault(); requestClose(); }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const r = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < r.left ||
            event.clientX > r.right ||
            event.clientY < r.top ||
            event.clientY > r.bottom
          )
            requestClose();
        }
      }}
    >
      <div className="sp-dialog-header">
        <h2 id={`${id}-title`}>{title}</h2>
        <IconButton label="Close dialog" onClick={requestClose}>
          <X size={20} />
        </IconButton>
      </div>
      {description && (
        <p id={`${id}-description`} className="sp-dialog-description">
          {description}
        </p>
      )}
      {children}
    </dialog>
  );
}
export function Skeleton({
  width = "100%",
  height = 14,
}: {
  width?: string | number;
  height?: number;
}) {
  return (
    <span
      className="sp-skeleton"
      aria-hidden="true"
      style={{ width, height }}
    />
  );
}
export function ChannelItem({
  name,
  selected = false,
  unread = 0,
  icon,
  onClick,
}: {
  name: string;
  selected?: boolean;
  unread?: number;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`sp-channel ${unread ? "sp-channel--unread" : ""}`}
      aria-current={selected ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{name}</span>
      {unread > 0 && (
        <span className="sp-unread" aria-label={`${unread} unread`}>
          {unread}
        </span>
      )}
    </button>
  );
}
