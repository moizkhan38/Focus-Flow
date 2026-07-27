import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatDate } from './utils';

export function exportToJSON(report) {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sprint-report-${report.sprint?.name || 'export'}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportToCSV(report) {
  const rows = [
    ['Sprint Report', report.sprint?.name || ''],
    ['Period', `${formatDate(report.sprint?.startDate)} - ${formatDate(report.sprint?.endDate)}`],
    ['Completion Rate', `${Math.round((report.completedIssues / report.totalIssues) * 100)}%`],
    ['Story Points', `${report.completedPoints}/${report.totalPoints}`],
    ['Health Score', `${report.healthScore?.score} (${report.healthScore?.level})`],
    [],
    ['Key', 'Summary', 'Type', 'Status', 'Priority', 'Assignee', 'Story Points'],
    ...(report.issues || []).map((i) => [
      i.key, i.summary, i.issueType, i.status, i.priority,
      i.assignee?.name || 'Unassigned', i.storyPoints || '',
    ]),
  ];

  // CSV formula injection: Excel and Sheets execute a cell that begins with
  // = + - @ (or tab/CR), so a Jira summary like `=HYPERLINK("http://evil","click")`
  // — text any Jira user can write — would run when a teammate opens the export.
  // Quoting alone does not prevent it; the leading character must be neutralised.
  const csvCell = (c) => {
    const s = String(c ?? '');
    const escaped = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return `"${escaped.replace(/"/g, '""')}"`;
  };

  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sprint-report-${report.sprint?.name || 'export'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportToPDF(report) {
  const doc = new jsPDF();

  doc.setFontSize(18);
  doc.text('Sprint Report', 14, 20);

  doc.setFontSize(12);
  doc.text(`Sprint: ${report.sprint?.name || 'N/A'}`, 14, 30);
  doc.text(`Period: ${formatDate(report.sprint?.startDate)} - ${formatDate(report.sprint?.endDate)}`, 14, 37);
  doc.text(`Completion: ${report.completedIssues}/${report.totalIssues} issues`, 14, 44);
  doc.text(`Story Points: ${report.completedPoints}/${report.totalPoints}`, 14, 51);
  doc.text(`Health Score: ${report.healthScore?.score} (${report.healthScore?.level})`, 14, 58);

  autoTable(doc, {
    startY: 68,
    head: [['Key', 'Summary', 'Type', 'Status', 'Priority', 'Assignee', 'SP']],
    body: (report.issues || []).map((i) => [
      i.key, i.summary, i.issueType, i.status, i.priority,
      i.assignee?.name || 'Unassigned', i.storyPoints || '',
    ]),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [59, 130, 246] },
  });

  doc.save(`sprint-report-${report.sprint?.name || 'export'}.pdf`);
}
