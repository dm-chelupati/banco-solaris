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

// ── Payment Gateway Simulator ──
// BUG: The gateway has a hardcoded 3-second timeout, but the payment validation
// function has an exponential backoff retry that takes longer and longer.
// After several rapid payments, the cumulative delay exceeds the timeout → 500.
// The root cause is in validatePayment(): it uses a shared counter that never
// resets, causing delay = paymentCount * 200ms. At 15+ payments, delay > 3000ms.
let paymentCount = 0;
const GATEWAY_TIMEOUT_MS = 3000;

function validatePayment(loanId, amount) {
  return new Promise((resolve, reject) => {
    paymentCount++;
    // BUG: delay grows with every payment — simulates a connection pool leak
    // in the payment gateway client. Each payment adds 200ms because the
    // gateway client doesn't release connections properly.
    const delayMs = paymentCount * 200;
    console.log(`[GATEWAY] Payment #${paymentCount} for loan ${loanId}: validation delay ${delayMs}ms (timeout: ${GATEWAY_TIMEOUT_MS}ms)`);

    if (delayMs > GATEWAY_TIMEOUT_MS) {
      console.error(`[ERROR] Payment gateway timeout: validation took ${delayMs}ms > ${GATEWAY_TIMEOUT_MS}ms limit`);
      console.error(`[ERROR] paymentCount=${paymentCount}, gateway connections not released`);
      reject(new Error(`Payment gateway timeout after ${GATEWAY_TIMEOUT_MS}ms — gateway connection pool exhausted (${paymentCount} unreleased connections)`));
      return;
    }

    setTimeout(() => {
      resolve({ transactionId: `TXN-${Date.now()}`, status: 'approved' });
    }, delayMs);
  });
}

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
app.post('/api/loans/:id/payment', async (req, res) => {
  const loan = loans.find(l => l.id === parseInt(req.params.id));
  if (!loan) return res.status(404).json({ error: 'Empréstimo não encontrado' });

  try {
    const gatewayResult = await validatePayment(loan.id, req.body?.amount || 500);
    const amount = req.body?.amount || 500;
    loan.outstanding = Math.max(0, loan.outstanding - amount);
    if (loan.outstanding === 0) loan.status = 'paid';
    res.json({
      success: true, loan_id: loan.id, payment: amount,
      remaining: loan.outstanding, transactionId: gatewayResult.transactionId
    });
  } catch (err) {
    console.error(`[ERROR] Payment failed for loan ${loan.id}: ${err.message}`);
    res.status(500).json({
      error: 'Internal Server Error',
      message: err.message,
      code: 'GATEWAY_TIMEOUT',
      timestamp: new Date().toISOString()
    });
  }
});

// ── GET /api/stats ──
app.get('/api/stats', (req, res) => {
  res.json({
    totalLoans: loans.length,
    activeLoans: loans.filter(l => l.status === 'active').length,
    overdueLoans: loans.filter(l => l.status === 'overdue').length,
    totalOutstanding: loans.reduce((s, l) => s + l.outstanding, 0),
    paymentCount,
    currentDelayMs: paymentCount * 200,
    gatewayTimeoutMs: GATEWAY_TIMEOUT_MS,
    willTimeout: (paymentCount * 200) > GATEWAY_TIMEOUT_MS
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
