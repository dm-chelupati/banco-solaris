# Runbook: Order Service — Database Connectivity Failure

## Overview
This runbook covers investigation and remediation of PostgreSQL connectivity failures affecting `order-svc-7defkiyvn3r44` in `rg-contoso-swe`. The order service uses Npgsql (.NET) to connect to PostgreSQL at `4.225.165.61:5432`.

## Symptoms
- `GET /orders` and `GET /api/orders` return HTTP 500
- App Insights shows `System.TimeoutException: Failed to connect to 4.225.165.61:5432`
- Average response duration jumps to ~15,000ms (connection timeout)
- Container logs show `fail: OrderService[0] Database error on GET /orders`
- 100% failure rate on all database-dependent endpoints

## Resource Reference

| Resource | Value |
|---|---|
| Container App | `order-svc-7defkiyvn3r44` |
| Resource Group | `rg-contoso-swe` |
| Region | Sweden Central |
| App Insights | `ai-7defkiyvn3r44` |
| Log Analytics Workspace ID | `a7c3beed-20d9-49c1-938e-78ac80a7ae58` |
| PostgreSQL Host | `4.225.165.61:5432` |
| Container App Environment | `env-7defkiyvn3r44` |
| Latest Revision (as of 2026-05-29) | `order-svc-7defkiyvn3r44--0000009` |
| Internal FQDN | `order-svc-7defkiyvn3r44.internal.agreeableplant-397f5843.swedencentral.azurecontainerapps.io` |

## Phase 1: Confirm the Failure

### Identify affected service from App Insights
Always check `cloud_RoleName` first to confirm which service is affected:

```kql
-- Run against App Insights ai-7defkiyvn3r44
exceptions
| where timestamp > ago(30m)
| project timestamp, type, outerMessage, cloud_RoleName, cloud_RoleInstance
| order by timestamp desc
| take 20
```

### Check error rate and response times
```kql
requests
| where timestamp > ago(30m)
| summarize TotalRequests=count(), FailedRequests=countif(resultCode startswith "5"), AvgDuration=avg(duration) by cloud_RoleName, bin(timestamp, 5m)
| order by timestamp desc
```

### Check container logs
```kql
-- Run against Log Analytics workspace a7c3beed-20d9-49c1-938e-78ac80a7ae58
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30m)
| where ContainerAppName_s == "order-svc-7defkiyvn3r44"
| where Log_s contains "error" or Log_s contains "fail" or Log_s contains "timeout"
| project TimeGenerated, Log_s
| order by TimeGenerated desc
| take 50
```

## Phase 2: Check Database Connectivity

### Verify PostgreSQL server reachability
The database at `4.225.165.61:5432` is external to Azure. Check:
1. Is the PostgreSQL server running?
2. Are there NSG or firewall rules blocking port 5432?
3. Has any network configuration changed recently?

### Check Azure Activity Logs for network changes
```bash
az monitor activity-log list \
  --resource-group rg-contoso-swe \
  --subscription cbf44432-7f45-4906-a85d-d2b14a1e8328 \
  --offset 24h \
  --query "[?contains(operationName.value, 'NetworkSecurityGroups') || contains(operationName.value, 'firewallRules')].{time:eventTimestamp, operation:operationName.value, status:status.value, caller:caller}" \
  -o table
```

## Phase 3: Remediate

### Restart the container app revision
```bash
az containerapp revision restart \
  -g rg-contoso-swe \
  -n order-svc-7defkiyvn3r44 \
  --revision <current-revision-name> \
  --subscription cbf44432-7f45-4906-a85d-d2b14a1e8328
```

To find the current revision:
```bash
az containerapp show \
  -g rg-contoso-swe \
  -n order-svc-7defkiyvn3r44 \
  --subscription cbf44432-7f45-4906-a85d-d2b14a1e8328 \
  --query "{latestRevision:properties.latestRevisionName, runningStatus:properties.runningStatus}"
```

### Verify recovery
After restart, wait 2-3 minutes for telemetry ingestion, then:
```kql
-- Check for new errors post-restart
exceptions
| where timestamp > ago(5m)
| summarize ExceptionCount=count() by type, outerMessage, bin(timestamp, 1m)
| order by timestamp desc

-- Check for successful requests
requests
| where timestamp > ago(5m)
| summarize TotalRequests=count(), SuccessCount=countif(toint(resultCode) >= 200 and toint(resultCode) < 300) by bin(timestamp, 1m)
| order by timestamp desc
```

## Phase 4: Escalation

If the restart does not resolve the issue:
1. The PostgreSQL server at `4.225.165.61` may be down — escalate to the database team
2. Check if NSG rules were modified — revert if necessary
3. Check if the Container App Environment has network connectivity issues
4. Review the other services in `rg-contoso-swe` (`payment-svc`, `gateway`, `worker`) for similar DB failures

## Related Services in rg-contoso-swe

| Service | Type | Notes |
|---|---|---|
| gateway-7defkiyvn3r44 | Container App | API gateway — may also be affected |
| payment-svc-7defkiyvn3r44 | Container App | Payment service — may share DB |
| worker-7defkiyvn3r44 | Container App | Background worker |
| frontend-7defkiyvn3r44 | Web App | Frontend — depends on order-svc |

## Incident History

| Date | Issue | Resolution | GitHub Issue |
|---|---|---|---|
| 2026-05-29 | DB connectivity loss to 4.225.165.61:5432 | Container app restart | [#5](https://github.com/dm-chelupati/banco-solaris/issues/5) |
