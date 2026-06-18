.PHONY: install dev docker-up docker-down test-backend test-ui test-all test-coverage

install:
	cd backend && pip install -r requirements.txt
	cd frontend && npm install
	cd tests/ui && npm install && npx playwright install

dev:
	@echo "Starting backend and frontend..."
	cd backend && uvicorn main:app --reload --port 9000 &
	cd frontend && npm run dev &
	@echo "Backend: http://localhost:9000"
	@echo "Frontend: http://localhost:5173"

docker-up:
	docker compose up -d

docker-down:
	docker compose down

test-backend:
	cd tests && python -m pytest backend/ -v --cov=../backend --cov-report=term-missing

test-ui:
	cd tests/ui && npx playwright test --reporter=list

test-all:
	make test-backend && make test-ui

test-coverage:
	cd tests && python -m pytest backend/ --cov=../backend --cov-report=html:coverage/
	@echo "Coverage report: tests/coverage/index.html"
