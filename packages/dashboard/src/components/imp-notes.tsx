import type { Imp } from '@zgeoff/imp-client';
import { buildImpNotes } from '../lib/imp-notes';
import styles from './imp-notes.module.css';

interface ImpNotesProps {
  readonly imp: Imp;
  readonly nowMs: number;
}

export function ImpNotes(props: ImpNotesProps) {
  const notes = buildImpNotes(props.imp, props.nowMs);

  if (notes.length === 0) {
    return null;
  }

  return (
    <ul className={styles['notes']}>
      {notes.map((note) => (
        <li key={note.text} className={styles[note.tone]}>
          {note.text}
        </li>
      ))}
    </ul>
  );
}
