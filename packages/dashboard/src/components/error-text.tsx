import styles from './error-text.module.css';

interface ErrorTextProps {
  readonly error: Error | null;
}

// the message of a failed query or mutation, or nothing
export function ErrorText(props: ErrorTextProps) {
  if (props.error === null) {
    return null;
  }

  return (
    <p className={styles['error']} role="alert">
      {props.error.message}
    </p>
  );
}
