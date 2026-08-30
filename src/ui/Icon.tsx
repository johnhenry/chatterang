/**
 * Icon set.
 *
 * Hand-drawn on a 24-unit grid with a 1.6 stroke, which reads correctly at
 * the 18–22px sizes the app actually uses. No icon font, no runtime
 * dependency, and no glyph that means something different than it looks like.
 */

export type IconName =
  | 'chat'
  | 'models'
  | 'personas'
  | 'studio'
  | 'settings'
  | 'send'
  | 'stop'
  | 'plus'
  | 'close'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'copy'
  | 'edit'
  | 'trash'
  | 'refresh'
  | 'download'
  | 'image'
  | 'mic'
  | 'speaker'
  | 'sliders'
  | 'tool'
  | 'gauge'
  | 'flame'
  | 'cloud'
  | 'chip'
  | 'pin'
  | 'search'
  | 'brain'
  | 'shield'
  | 'star'
  | 'bag'
  | 'more'
  | 'alert'
  | 'dots';

const PATHS: Record<IconName, string> = {
  chat: 'M4 5.5h16v10.5H9.5L5 19.5V16H4z',
  models: 'M12 3.2 20.2 7.6v8.8L12 20.8 3.8 16.4V7.6zM3.8 7.6 12 12m0 0 8.2-4.4M12 12v8.8',
  personas: 'M12 4.2a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8M5 20.2c0-3.4 3.1-5.6 7-5.6s7 2.2 7 5.6',
  studio: 'M4.5 5h15v14h-15zM4.5 15.4l4.3-4.1 3.3 3.1 3.2-3.6 4.2 4.6M9.3 9.4a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0',
  settings:
    'M12 15.1a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2M19.3 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.5 1v.3a1.9 1.9 0 1 1-3.7 0v-.1a1.5 1.5 0 0 0-2.6-1l-.1.1a1.9 1.9 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1-2.5H4a1.9 1.9 0 1 1 0-3.7h.1a1.5 1.5 0 0 0 1-2.6l-.1-.1a1.9 1.9 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3H9.5a1.5 1.5 0 0 0 .9-1.4V4a1.9 1.9 0 1 1 3.7 0v.1a1.5 1.5 0 0 0 2.5 1l.1-.1a1.9 1.9 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1 2.5h.3a1.9 1.9 0 1 1 0 3.7h-.1a1.5 1.5 0 0 0-1.4.9',
  send: 'M4.5 12 20 4.5 15.6 20l-3.4-5.6zm7.7 2.4L20 4.5',
  stop: 'M7.5 7.5h9v9h-9z',
  plus: 'M12 5.5v13M5.5 12h13',
  close: 'M6.5 6.5l11 11m0-11-11 11',
  check: 'M5 12.8 9.6 17.4 19 8',
  'chevron-down': 'M6.5 9.5 12 15l5.5-5.5',
  'chevron-right': 'M9.5 6.5 15 12l-5.5 5.5',
  'chevron-left': 'M14.5 6.5 9 12l5.5 5.5',
  copy: 'M9 9h10v11H9zM15 9V4H5v11h4',
  edit: 'M4.5 19.5h4l10-10a2.1 2.1 0 0 0-3-3l-10 10zM14 6.5l3.5 3.5',
  trash: 'M5 7h14M9.5 7V4.5h5V7M6.8 7l.8 12.5h8.8L17.2 7M10 10.5v6M14 10.5v6',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.4-5.5M19.5 4v4h-4',
  download: 'M12 4v11m0 0 4.2-4.2M12 15l-4.2-4.2M4.5 18.5h15',
  image: 'M4.5 5h15v14h-15zM4.5 15.4l4.3-4.1 3.3 3.1 3.2-3.6 4.2 4.6M9.3 9.4a1.1 1.1 0 1 1-2.2 0 1.1 1.1 0 0 1 2.2 0',
  mic: 'M12 3.8a2.6 2.6 0 0 1 2.6 2.6v5.2a2.6 2.6 0 0 1-5.2 0V6.4A2.6 2.6 0 0 1 12 3.8M6.5 11a5.5 5.5 0 0 0 11 0M12 16.5v3.7M9 20.2h6',
  speaker: 'M4.5 9.5h3l4-3.5v12l-4-3.5h-3zM15 9.2a4 4 0 0 1 0 5.6M17.6 6.6a7.6 7.6 0 0 1 0 10.8',
  sliders: 'M4.5 7.5h9m3 0h3M4.5 16.5h3m3 0h9M14.5 4.5v6M8.5 13.5v6',
  tool: 'M14.3 4.6a4.6 4.6 0 0 0 5.6 6.2L21 12l-8.4 8.4a2.3 2.3 0 0 1-3.2-3.2L17.8 9l1.1-1.1',
  gauge: 'M4.6 17.4a7.6 7.6 0 1 1 14.8 0M12 17.4l3.6-5.2M12 17.4h.01',
  flame: 'M12 3.5c3.4 3 5 5.6 5 8.4a5 5 0 0 1-10 0c0-1.5.5-2.6 1.5-3.6 0 1.6.9 2.4 1.8 2.4 1.2 0 1.7-1 1.7-2.6 0-1.5-.3-3-1-4.6',
  cloud: 'M7 18.5a3.8 3.8 0 0 1-.4-7.6A5.3 5.3 0 0 1 17 10.5a3.9 3.9 0 0 1-.5 8z',
  chip: 'M7.5 7.5h9v9h-9zM9.5 4v3.5M14.5 4v3.5M9.5 16.5V20M14.5 16.5V20M4 9.5h3.5M4 14.5h3.5M16.5 9.5H20M16.5 14.5H20',
  pin: 'M9 4.5h6l-.8 5.2 3 3.3H6.8l3-3.3zM12 13v6.5',
  search: 'M11 4.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13M15.8 15.8 20 20',
  brain: 'M9.5 4.5a2.7 2.7 0 0 0-2.7 2.7 2.6 2.6 0 0 0-1.6 4.5A2.7 2.7 0 0 0 7 16.4a2.7 2.7 0 0 0 5.2.9V5.9a2.7 2.7 0 0 0-2.7-1.4M14.5 4.5a2.7 2.7 0 0 1 2.7 2.7 2.6 2.6 0 0 1 1.6 4.5 2.7 2.7 0 0 1-1.8 4.7 2.7 2.7 0 0 1-5-.4',
  shield: 'M12 3.8 19 6.4v5.3c0 4-2.9 7.4-7 8.5-4.1-1.1-7-4.5-7-8.5V6.4z',
  star: 'M12 4.2l2.3 4.9 5.2.7-3.8 3.8.9 5.3-4.6-2.6-4.6 2.6.9-5.3L4.5 9.8l5.2-.7z',
  bag: 'M5.5 8h13l-1 11.5h-11zM9 8V6a3 3 0 0 1 6 0v2',
  more: 'M5.5 12h13M5.5 6.5h13M5.5 17.5h13',
  alert: 'M12 4.5 21 19.5H3zM12 10v4.2M12 16.6v.1',
  dots: 'M6.2 12h.1M12 12h.1M17.8 12h.1',
};

export interface IconProps {
  name: IconName;
  size?: number;
  /** Filled shapes need no round caps; the default suits strokes. */
  className?: string;
}

export function Icon({ name, size = 20, className }: IconProps): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
