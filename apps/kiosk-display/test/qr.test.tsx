import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { Qr, qrPath } from '../src/ui/Qr.tsx';

afterEach(cleanup);

const payload = 'maxcom1:' + 'A1b2C3d4_-'.repeat(30);

describe('Qr', () => {
  it('renders one path for a 300-character payload, with a quiet zone and a labelled svg', () => {
    const { getByTestId, container } = render(<Qr text={payload} size={400} />);
    const svg = getByTestId('qr');
    expect(svg.getAttribute('aria-label')).toBe('Kod QR');
    expect(svg.getAttribute('width')).toBe('400');
    expect(container.querySelectorAll('path')).toHaveLength(1);
    expect((container.querySelector('path')!.getAttribute('d') ?? '').length).toBeGreaterThan(500);
    const [, , w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    expect(w).toBe(h);
    // a 4-module quiet zone on each side: the first dark module is at least 4 in
    const xs = [...(container.querySelector('path')!.getAttribute('d') ?? '').matchAll(/M(\d+) (\d+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(4);
  });

  it('renders nothing for an empty string', () => {
    const { container, queryByTestId } = render(<Qr text="" size={100} />);
    expect(queryByTestId('qr')).toBeNull();
    expect(container.innerHTML).toBe('');
  });

  it('draws different codes for different text and the same code for the same text', () => {
    expect(qrPath(payload)!.d).toBe(qrPath(payload)!.d);
    expect(qrPath(payload)!.d).not.toBe(qrPath(payload + 'x')!.d);
  });

  it('draws nothing instead of throwing when the text is too long for any QR version', () => {
    expect(qrPath('x'.repeat(4000))).toBeNull();
  });
});
