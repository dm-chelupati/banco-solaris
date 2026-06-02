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
// FIX: Uses a concurrent connection counter that properly acquires/releases
// connections. Each payment acquires a connection (incrementing activeConnections)
// and releases it after validation completes (decrementing activeConnections).
// The delay is based only on currently active concurrent connections, not
// cumulative lifetime payments. This prevents unbounded growth.
let activeConnections = 0;
let totalPaymentCount = 0;
const GATEWAY_TIMEOUT_MS = 3000;
const MAX_CONCURRENT_CONNECTIONS = 15;

function validatePayment(loanId, amount) {
  return new Promise((resolve, reject) => {
    totalPaymentCount++;
    activeConnections++;
    const currentDelay = activeConnections * 200;
    console.log(`[GATEWAY] Payment #${totalPaymentCount} for loan ${loanId}: ${activeConnections} active connections, delay ${currentDelay}ms (timeout: ${GATEWAY_TIMEOUT_MS}ms)`);

    if (activeConnections > MAX_CONCURRENT_CONNECTIONS) {
      activeConnections--;
      console.error(`[ERROR] Payment gateway: max concurrent connections (${MAX_CONCURRENT_CONNECTIONS}) exceeded`);
      reject(new Error(`Payment gateway connection pool exhausted — ${MAX_CONCURRENT_CONNECTIONS} max concurrent connections`));
      return;
    }

    if (currentDelay > GATEWAY_TIMEOUT_MS) {
      activeConnections--;
      console.error(`[ERROR] Payment gateway timeout: delay ${currentDelay}ms > ${GATEWAY_TIMEOUT_MS}ms limit`);
      reject(new Error(`Payment gateway timeout after ${GATEWAY_TIMEOUT_MS}ms — too many concurrent requests`));
      return;
    }

    setTimeout(() => {
      activeConnections--; // Release connection after validation completes
      console.log(`[GATEWAY] Payment #${totalPaymentCount} for loan ${loanId}: connection released, ${activeConnections} active`);
      resolve({ transactionId: `TXN-${Date.now()}`, status: 'approved' });
    }, currentDelay);
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
    totalPaymentCount,
    activeConnections,
    maxConcurrentConnections: MAX_CONCURRENT_CONNECTIONS,
    currentDelayMs: activeConnections * 200,
    gatewayTimeoutMs: GATEWAY_TIMEOUT_MS,
    willTimeout: (activeConnections * 200) > GATEWAY_TIMEOUT_MS
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
