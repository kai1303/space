import './space-logo.css';

export function SpaceLogo({ icon = false, inverse = false }: { icon?: boolean; inverse?: boolean }) {
  return <svg
    className={`space-logo${icon ? ' space-logo--icon' : ''}${inverse ? ' space-logo--inverse' : ''}`}
    viewBox={icon ? '75 120 500 500' : '75 120 2030 500'}
    role="img"
    aria-label="Space"
  >
    <image href="/brand/space-logo.png" width="2172" height="724" />
  </svg>;
}
