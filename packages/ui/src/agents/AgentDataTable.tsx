import { useId, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { motionTransition } from '../motion/motion.js';
import { ArrowDown, ArrowUp, ArrowsDownUp, MagnifyingGlass } from '@phosphor-icons/react';
import type { DataTableBlock } from '@space/contracts';

const alphabetic = new Intl.Collator(undefined, { sensitivity: 'base' });

export function AgentDataTable({ block }: { block: DataTableBlock }) {
  const { title, columns, rows } = block;
  const heading = useId();
  const reduced = useReducedMotion();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ column: number; ascending: boolean }>();
  const query = filter.trim().toLocaleLowerCase();
  const visible = rows.filter(row => row.some(cell => String(cell).toLocaleLowerCase().includes(query)));
  if (sort) {
    const { column, ascending } = sort;
    const numeric = rows.every(row => typeof row[column] === 'number');
    visible.sort((first, second) => {
      const a = first[column]!, b = second[column]!;
      const order = numeric ? Number(a) - Number(b) : alphabetic.compare(String(a), String(b));
      return ascending ? order : -order;
    });
  }

  // Snapshots contain plain cells. An occurrence count distinguishes identical rows.
  const occurrences = new Map<string, number>();
  return <section className="sp-agent-data-table" aria-labelledby={heading}>
    <header>
      <h4 id={heading}>{title}</h4>
      <label className="sp-agent-data-filter"><MagnifyingGlass size={16} aria-hidden="true" />
        <input type="search" aria-label={'Filter ' + title} placeholder="Filter rows" value={filter}
          onChange={event => setFilter(event.target.value)} />
      </label>
    </header>
    <motion.div layoutScroll className="sp-agent-table-scroll" role="region" aria-label={title + ' rows'} tabIndex={0}>
      <table aria-labelledby={heading}>
        <thead><tr>{columns.map((label, column) => {
          const active = sort?.column === column;
          const Icon = active ? (sort.ascending ? ArrowUp : ArrowDown) : ArrowsDownUp;
          return <th key={column} scope="col" aria-sort={active ? (sort.ascending ? 'ascending' : 'descending') : undefined}>
            <button type="button" onClick={() => setSort({ column, ascending: !active || !sort.ascending })}>
              {label}<Icon size={14} aria-hidden="true" />
            </button>
          </th>;
        })}</tr></thead>
        <tbody>{visible.map(row => {
          const signature = JSON.stringify(row);
          const occurrence = occurrences.get(signature) ?? 0;
          occurrences.set(signature, occurrence + 1);
          return <motion.tr key={signature + ':' + occurrence} layout={reduced ? false : 'position'}
            transition={motionTransition(reduced, 0.24)}>
            {row.map((cell, column) => <td key={column}>{cell}</td>)}
          </motion.tr>;
        })}</tbody>
      </table>
    </motion.div>
    <small role="status">{visible.length === 0
      ? (rows.length ? 'No matching rows' : 'No results')
      : query ? `${visible.length} of ${rows.length} rows` : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`}</small>
  </section>;
}
