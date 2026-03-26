const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// ── Loan data (in-memory) ──
const loans = [
  { id: 1, customer: 'Maria Silva', cpf: '***.***.***-12', type: 'Crédito Pessoal', amount: 45000, outstanding: 32150, rate: 1.89, term: 48, status: 'active', nextPayment: '2026-04-15' },
  { id: 2, customer: 'João Santos', cpf: '***.***.***-34', type: 'Crédito Imobiliário', amount: 380000, outstanding: 295000, rate: 0.75, term: 360, status: 'active', nextPayment: '2026-04-01' },
  { id: 3, customer: 'Ana Oliveira', cpf: '***.***.***-56', type: 'Crédito Consignado', amount: 18000, outstanding: 12400, rate: 1.29, term: 36, status: 'active', nextPayment: '2026-04-10' },
  { id: 4, customer: 'Carlos Ferreira', cpf: '***.***.***-78', type: 'Financiamento de Veículo', amount: 62000, outstanding: 48300, rate: 1.49, term: 60, status: 'active', nextPayment: '2026-04-05' },
  { id: 5, customer: 'Luciana Costa', cpf: '***.***.***-90', type: 'Crédito Pessoal', amount: 25000, outstanding: 8750, rate: 1.89, term: 24, status: 'active', nextPayment: '2026-04-20' },
  { id: 6, customer: 'Roberto Almeida', cpf: '***.***.***-01', type: 'Crédito Empresarial', amount: 150000, outstanding: 127500, rate: 1.15, term: 48, status: 'overdue', nextPayment: '2026-03-15' },
  { id: 7, customer: 'Fernanda Lima', cpf: '***.***.***-23', type: 'Crédito Imobiliário', amount: 520000, outstanding: 480000, rate: 0.69, term: 360, status: 'active', nextPayment: '2026-04-01' },
  { id: 8, customer: 'Pedro Rocha', cpf: '***.***.***-45', type: 'Crédito Consignado', amount: 12000, outstanding: 0, rate: 1.29, term: 24, status: 'paid', nextPayment: null },
];

// ── Payment transaction log — BUG: grows unbounded, never cleaned up ──
// This is an intentional memory leak for SRE Agent investigation demo.
// Every payment attempt stores the full request + response payload with
// no eviction policy. Under load, this exhausts container memory → OOM → 500s.
const paymentAuditLog = [];

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'banco-solaris-api', timestamp: new Date().toISOString() });
});

// ── GET /api/loans ──
app.get('/api/loans', (req, res) => {
  const summary = loans.map(l => ({
    id: l.id, customer: l.customer, type: l.type,
    outstanding: l.outstanding, status: l.status, nextPayment: l.nextPayment
  }));
  res.json({ loans: summary, total: loans.length });
});

// ── GET /api/loans/:id ──
app.get('/api/loans/:id', (req, res) => {
  const loan = loans.find(l => l.id === parseInt(req.params.id));
  if (!loan) return res.status(404).json({ error: 'Empréstimo não encontrado' });
  res.json(loan);
});

// ── POST /api/loans/:id/payment ──
// BUG: Each payment stores a large audit entry in memory with no cleanup.
// The audit log includes duplicated loan data, full headers, and a 10KB
// padding string per entry. At ~200 requests this fills 1Gi container memory.
app.post('/api/loans/:id/payment', (req, res) => {
  const loan = loans.find(l => l.id === parseInt(req.params.id));
  if (!loan) return res.status(404).json({ error: 'Empréstimo não encontrado' });

  // Store bloated audit entry — this is the memory leak
  const auditEntry = {
    timestamp: new Date().toISOString(),
    loanId: loan.id,
    customer: loan.customer,
    amount: req.body?.amount || 500,
    headers: JSON.stringify(req.headers),
    loanSnapshot: JSON.parse(JSON.stringify(loan)),
    padding: 'X'.repeat(10000), // 10KB padding per entry — accelerates OOM
    requestId: `PAY-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  paymentAuditLog.push(auditEntry);

  // Log memory usage (visible in container logs)
  const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const logCount = paymentAuditLog.length;
  console.log(`[PAYMENT] Loan ${loan.id} | audit entries: ${logCount} | heap: ${memMB}MB`);

  // When memory pressure is high, start failing
  if (process.memoryUsage().heapUsed > 800 * 1024 * 1024) {
    console.error(`[ERROR] Payment processing failed — heap ${memMB}MB exceeds threshold`);
    console.error(`[ERROR] paymentAuditLog has ${logCount} entries consuming excessive memory`);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Payment processing failed: out of memory',
      code: 'OOM_AUDIT_LOG',
      timestamp: new Date().toISOString()
    });
  }

  const amount = req.body?.amount || 500;
  loan.outstanding = Math.max(0, loan.outstanding - amount);
  if (loan.outstanding === 0) loan.status = 'paid';
  res.json({ success: true, loan_id: loan.id, payment: amount, remaining: loan.outstanding });
});

// ── GET /api/stats ──
app.get('/api/stats', (req, res) => {
  const memMB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  res.json({
    totalLoans: loans.length,
    activeLoans: loans.filter(l => l.status === 'active').length,
    overdueLoans: loans.filter(l => l.status === 'overdue').length,
    totalOutstanding: loans.reduce((s, l) => s + l.outstanding, 0),
    auditLogEntries: paymentAuditLog.length,
    heapUsedMB: parseFloat(memMB)
  });
});

// ── Serve frontend ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Banco Solaris API running on port ${PORT}`);
});
