// Indian public holidays shown on everyone's Calendar (read-only). Central
// Government (DoPT) gazetted holidays + the three national holidays, plus major
// festivals widely observed in Delhi/North India. Movable (lunar) festival dates
// follow the official DoPT notifications; Id-* dates may shift a day on moon
// sighting. Append more years to HOLIDAYS as they are notified.
//
// type: 'national' (Republic/Independence/Gandhi — compulsory everywhere),
//       'gazetted' (DoPT central gazetted), 'festival' (major festival).

export const HOLIDAYS = [
  // ---------------- 2026 ----------------
  { date: '2026-01-14', name: 'Makar Sankranti / Pongal', type: 'festival' },
  { date: '2026-01-26', name: 'Republic Day', type: 'national' },
  { date: '2026-02-15', name: 'Maha Shivaratri', type: 'festival' },
  { date: '2026-03-04', name: 'Holi', type: 'gazetted' },
  { date: '2026-03-21', name: 'Id-ul-Fitr', type: 'gazetted' },
  { date: '2026-03-26', name: 'Ram Navami', type: 'gazetted' },
  { date: '2026-03-31', name: 'Mahavir Jayanti', type: 'gazetted' },
  { date: '2026-04-03', name: 'Good Friday', type: 'gazetted' },
  { date: '2026-05-01', name: 'Buddha Purnima', type: 'gazetted' },
  { date: '2026-05-27', name: 'Id-ul-Zuha (Bakrid)', type: 'gazetted' },
  { date: '2026-06-26', name: 'Muharram', type: 'gazetted' },
  { date: '2026-08-15', name: 'Independence Day', type: 'national' },
  { date: '2026-08-26', name: 'Milad-un-Nabi (Id-e-Milad)', type: 'gazetted' },
  { date: '2026-08-28', name: 'Raksha Bandhan', type: 'festival' },
  { date: '2026-09-04', name: 'Janmashtami', type: 'gazetted' },
  { date: '2026-09-14', name: 'Ganesh Chaturthi', type: 'festival' },
  { date: '2026-10-02', name: 'Gandhi Jayanti', type: 'national' },
  { date: '2026-10-11', name: 'Navratri begins', type: 'festival' },
  { date: '2026-10-20', name: 'Dussehra (Vijaya Dashami)', type: 'gazetted' },
  { date: '2026-10-29', name: 'Karva Chauth', type: 'festival' },
  { date: '2026-11-08', name: 'Diwali (Deepavali)', type: 'gazetted' },
  { date: '2026-11-15', name: 'Chhath Puja', type: 'festival' },
  { date: '2026-11-24', name: 'Guru Nanak’s Birthday', type: 'gazetted' },
  { date: '2026-12-25', name: 'Christmas', type: 'gazetted' },

  // ---------------- 2027 (DoPT O.M. dated 16 Jul 2026) ----------------
  { date: '2027-01-26', name: 'Republic Day', type: 'national' },
  { date: '2027-03-10', name: 'Id-ul-Fitr', type: 'gazetted' },
  { date: '2027-03-23', name: 'Holi', type: 'gazetted' },
  { date: '2027-03-26', name: 'Good Friday', type: 'gazetted' },
  { date: '2027-04-15', name: 'Ram Navami', type: 'gazetted' },
  { date: '2027-04-19', name: 'Mahavir Jayanti', type: 'gazetted' },
  { date: '2027-05-17', name: 'Id-ul-Zuha (Bakrid)', type: 'gazetted' },
  { date: '2027-05-20', name: 'Buddha Purnima', type: 'gazetted' },
  { date: '2027-06-16', name: 'Muharram', type: 'gazetted' },
  { date: '2027-08-15', name: 'Independence Day', type: 'national' },
  { date: '2027-08-15', name: 'Milad-un-Nabi (Id-e-Milad)', type: 'gazetted' },
  { date: '2027-08-25', name: 'Janmashtami', type: 'gazetted' },
  { date: '2027-10-02', name: 'Gandhi Jayanti', type: 'national' },
  { date: '2027-10-09', name: 'Dussehra (Vijaya Dashami)', type: 'gazetted' },
  { date: '2027-10-29', name: 'Diwali (Deepavali)', type: 'gazetted' },
  { date: '2027-11-14', name: 'Guru Nanak’s Birthday', type: 'gazetted' },
  { date: '2027-12-25', name: 'Christmas', type: 'gazetted' },
];

// Holidays whose date is within [from, to] (YYYY-MM-DD strings, inclusive).
export function holidaysInRange(from, to) {
  const lo = String(from).slice(0, 10);
  const hi = String(to).slice(0, 10);
  return HOLIDAYS.filter((h) => h.date >= lo && h.date <= hi);
}
