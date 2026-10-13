import { duePeriod, mailText } from './report-mail.module';

// Cairo is UTC+3 in October 2026 (summer time ends on the last Friday, 30 Oct).
const at = (iso: string) => new Date(iso);

describe('duePeriod', () => {
  it('daily: today, from 23:30 Cairo to midnight', () => {
    expect(duePeriod(at('2026-10-12T20:29:00Z'), 'daily')).toBeNull(); // 23:29
    expect(duePeriod(at('2026-10-12T20:30:00Z'), 'daily')).toEqual(['2026-10-12', '2026-10-12']);
    expect(duePeriod(at('2026-10-12T20:59:00Z'), 'daily')).toEqual(['2026-10-12', '2026-10-12']);
    // 00:10 Cairo is the next day, before its send time; in UTC it is still the 12th.
    expect(duePeriod(at('2026-10-12T21:10:00Z'), 'daily')).toBeNull();
  });

  it('weekly: Saturday to Friday, on Friday only', () => {
    expect(duePeriod(at('2026-10-16T20:31:00Z'), 'weekly')).toEqual(['2026-10-10', '2026-10-16']); // Fri 16 Oct
    expect(duePeriod(at('2026-10-15T20:31:00Z'), 'weekly')).toBeNull(); // Thursday
    expect(duePeriod(at('2026-10-16T19:00:00Z'), 'weekly')).toBeNull(); // Friday 22:00
  });

  it('off never sends, and the time is a knob', () => {
    expect(duePeriod(at('2026-10-16T20:31:00Z'), 'off')).toBeNull();
    expect(duePeriod(at('2026-10-12T07:05:00Z'), 'daily', '10:00')).toEqual(['2026-10-12', '2026-10-12']);
    expect(duePeriod(at('2026-10-12T06:55:00Z'), 'daily', '10:00')).toBeNull();
  });
});

describe('mailText', () => {
  const club = { name: { en: 'O House', ar: 'أو هاوس' } } as never;
  const summary = {
    total: 5,
    byStatus: [{ n: 3, en: 'Approved', ar: 'معتمدة' }, { n: 2, en: 'Expired', ar: 'منتهية' }],
    doneBy: [{ name: 'Mona <Adel>', n: 3 }],
    notDoneBy: ['Omar', 'Sara'],
  };
  const none = { total: 0, byStatus: [], doneBy: [], notDoneBy: [] };

  it('names the department (escaped) and briefs what happened and who did it, in both languages', () => {
    const m = mailText(club, { name_en: 'House <Keeping> ', name_ar: 'الاشراف' }, ['2026-10-12', '2026-10-12'], summary);
    expect(m.subject).toBe('O House · House <Keeping> · daily report · 12 October 2026');
    expect(m.html).toContain('Daily report · House &#60;Keeping&#62; · 12 October 2026');
    expect(m.html).toContain('5 checklists:</b> 3 Approved · 2 Expired');
    expect(m.html).toContain('Done by:</b> Mona &#60;Adel&#62; (3)');
    expect(m.html).toContain('Not done:</b> Omar, Sara');
    expect(m.html).toContain('التقرير اليومي · الاشراف');
    expect(m.html).toContain('٥ قائمة تحقق:</b> ٣ معتمدة · ٢ منتهية');
    expect(m.html).toContain('لم تُنجز:</b> Omar، Sara');
    expect(m.html).toContain('attached PDF');
  });

  it('the all-departments week, and an empty period says so', () => {
    const m = mailText(club, { name_en: null, name_ar: null }, ['2026-10-10', '2026-10-16'], none);
    expect(m.subject).toBe('O House · All departments · weekly report · 10 October 2026 – 16 October 2026');
    expect(m.html).toContain('التقرير الأسبوعي · كل الأقسام');
    expect(m.html).toContain('No checklists in this period.');
    expect(m.html).not.toContain('Done by');
  });
});
