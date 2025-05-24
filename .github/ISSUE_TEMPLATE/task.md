---
name: "🚀 Task"
about: "Use this template for new development tasks"
labels: ["task"]
assignees: []
---

## 🎫 Title
_A concise summary (5–10 words) of the task._

**Example:** `Improve search performance on product catalog`

---

## 📝 Summary
_A brief 1–2 sentence description of the problem and the desired outcome._

**Example:**  
Search queries on the product catalog currently exceed 500 ms under load. Optimize the query to reduce latency below 200 ms.

---

## 🎯 Objectives
- **Primary Objective:** What is the main goal?  
- **Secondary Objectives (optional):** Additional improvements or nice-to-haves.

---

## 📚 Background / Context
- Explanation of why this task is needed.  
- Links to design documents, user feedback, related discussions.

---

## 📌 Scope
- **In Scope:** Specific items to be delivered.  
- **Out of Scope:** What is explicitly excluded.

---

## 📋 Detailed Requirements

### Functional Requirements
1. FR-1: API endpoint `/search` accepts parameters `q`, `page`, `limit`.  
2. FR-2: Results sorted by relevance, then by ascending price.  
3. …

### Non-Functional Requirements
- 95th-percentile response time < 200 ms under 1 000 RPS.  
- Memory usage ≤ 200 MB.  
- Backward compatibility with existing clients.

---

## 🔗 Dependencies
- Related issues (e.g., Issue #123).  
- External services (e.g., Elasticsearch v7.9+).

---

## 📈 Success Metrics
- Average search latency reduced from 500 ms to < 200 ms.  
- CPU utilization under peak traffic reduced by 30%.  
- Error rate maintained or improved.

---

## ✅ Acceptance Criteria
- [ ] Endpoint `/search` returns JSON matching the OpenAPI schema.  
- [ ] Performance tests demonstrate required latency improvements.  
- [ ] Benchmarks integrated into CI pipeline.  
- [ ] Code reviewed and approved by at least two engineers.

---

## 🏁 Definition of Done
- [ ] Code merged into the `main` branch.  
- [ ] Unit tests cover all new code paths.  
- [ ] Integration and end-to-end tests added and passing.  
- [ ] Documentation updated (README, API reference, changelog).  
- [ ] Deployed to staging and smoke-tested.  
- [ ] Monitored in production for 24 hours without regressions.

---

## 🧪 Test Plan
- **Unit Tests:** Validate edge cases and error handling.  
- **Integration Tests:** Verify interaction with search ranking service.  
- **Performance Tests:** Load testing using JMeter/Gatling scripts.  
- **Manual Testing:** Steps to verify functionality and performance.

---

## ⏳ Estimation
- **Story Points:** _e.g._ 5  
- **Estimated Effort:** _e.g._ 3 days

---

## ⚙️ Technical Considerations
- Supported language and framework versions.  
- Database indexing strategy.  
- Caching mechanism (e.g., Redis) and invalidation policy.  
- Rollback and migration strategies.

---

## 🎨 UI/UX (if applicable)
- Links to wireframes or mockups (e.g., Figma, Zeplin).  
- Description of UI changes.

---

## 🔒 Security & Compliance
- Perform security analysis (e.g., OWASP).  
- Ensure proper authorization/authentication checks.

---

## 📊 Monitoring & Alerting
- Metrics to add to Grafana or Datadog.  
- Alert thresholds and on-call notifications (e.g., PagerDuty).

---

## ❓ Open Questions
1. Should wildcard search be supported?  
2. How should empty queries be handled?  
3. …

---

## 🗒️ Additional Notes
_Any extra information, links, or personal comments._
