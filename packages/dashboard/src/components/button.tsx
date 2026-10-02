import type { ReactNode } from 'react';
import styles from './button.module.css';

interface ButtonProps {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly tone?: 'default' | 'primary' | 'danger';
  readonly type?: 'button' | 'submit';
}

export function Button(props: ButtonProps) {
  const tone = props.tone ?? 'default';

  return (
    <button
      className={`${styles['button'] ?? ''} ${styles[tone] ?? ''}`}
      type={props.type === 'submit' ? 'submit' : 'button'}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
