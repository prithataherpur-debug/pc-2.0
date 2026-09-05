#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: "Backend-only validation of 3 new features: (1) /health probe route at root, (2) /api/customers/search by name or mobile, (3) reference_no propagated on linked_receipts across sales/collections/invoices/daybook. Plus regressions on /customers/lookup, /customers/{id}/ledger, and pdf_token."

backend:
  - task: "Deployment health probe (GET /health at root, no /api prefix)"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "testing"
          comment: "GET http://localhost:8001/health returns 200 {\"status\":\"ok\"} and GET / returns 200 {\"status\":\"ok\",\"service\":\"pritha-cabinet\"}. Note: public URL routes only /api/* to backend; /health on public URL returns Expo HTML (not the JSON). K8s pod-level probes hitting port 8001 will work as intended."

  - task: "GET /api/customers/search by name OR mobile"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "testing"
          comment: "Auth-required (401 without token). Empty q returns {customers:[],count:0}. Partial case-insensitive name match works. Digit-partial phone/phone_norm match works. is_mine flag correct per-user. All 8 seeded users (admin + emp1..emp7) can see customers regardless of assignee. Limit clamps to 1..100 (note: int(limit or 20) treats 0 as falsy → default 20, negative clamps to 1)."

  - task: "linked_receipts reference_no field on sales/collections/invoices/daybook"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: true
          agent: "testing"
          comment: "Created sale + receipt with reference_no='REF-XYZ-123' and confirmed it flows back on GET /api/sales?scope=all. Same verified for /api/collections (COLLREF-*), /api/invoices (INVREF-*). Daybook due_collection/daily_sales/invoices sections all carry reference_no (string) on each linked_receipt. pdf_token still populated (regression OK). source_type field also present on daybook linked_receipts."

  - task: "Regression: /api/customers/lookup"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
        - working: true
          agent: "testing"
          comment: "Lookup by phone returns {exists:true, customer:{...,is_mine:false}} correctly. Missing phone returns {exists:false}. Not broken by new /customers/search route ordering."

  - task: "Regression: /api/customers/{cust_id}/ledger"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
        - working: true
          agent: "testing"
          comment: "Ledger endpoint returns 200 with expected structure. Route still resolves after adding /customers/search sibling route."

frontend:
  - task: "N/A this run"
    implemented: true
    working: "NA"
    file: "-"
    stuck_count: 0
    priority: "low"
    needs_retesting: false
    status_history:
        - working: "NA"
          agent: "testing"
          comment: "Backend-only iteration; no frontend testing performed."

metadata:
  created_by: "testing_agent"
  version: "23"
  test_sequence: 23
  run_ui: false

test_plan:
  current_focus: []
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
    - agent: "testing"
      message: "Iteration 23 backend-only: 19/19 tests pass in /app/backend/tests/test_iteration23_search_health_refs.py (JUnit at /app/test_reports/pytest/iteration23.xml). All 3 new features working. /health note: only accessible on backend port 8001 (K8s probes hit pod directly). server.py is 3468 lines — recommend future split into modules, non-blocking."
