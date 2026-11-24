# RIDGE — იზოლირებული PostgreSQL QA

ეს პროცედურა ქმნის დროებით, მხოლოდ QA-სთვის განკუთვნილ PostgreSQL კონტეინერს. ის არ იყენებს Production/Supabase პროექტს და არ ეხება არსებულ მონაცემებს. მონაცემთა დირექტორია `tmpfs`-შია და კონტეინერის წაშლისას ქრება.

## გაშვება Windows-ზე

PowerShell-იდან, RIDGE პროექტის root საქაღალდეში:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Tools\Database\Run-PostgresIntegration.ps1
```

საჭიროა Docker Desktop-ის გაშვება და Node.js 22+. თუ `pg` dependency ჯერ არ არის დაყენებული, სკრიპტი გაუშვებს `npm install`-ს.

## რას ამოწმებს

1. დროებითი PostgreSQL 16 კონტეინერის გაშვება loopback მისამართზე.
2. `database/migrations/001–008`-ის თანმიმდევრული გამოყენება `ON_ERROR_STOP` რეჟიმით.
3. player/job/checkpoint მონაცემების შექმნა Dedicated Server service-ის მეშვეობით.
4. checkpoint-ის თანმიმდევრობა და completion proof.
5. ჯილდოს ერთჯერადი გაცემის, idempotency-ისა და balanced ledger-ის შემოწმება.
6. Backend service-ის დახურვა/ხელახლა გახსნა და wallet/job მონაცემების აღდგენა.
7. Dedicated Server credential issuance/rotation/revocation audit-ის, trusted service actor-ისა და append-only trigger-ის შემოწმება.
8. დროებითი კონტეინერისა და მისი მონაცემების წაშლა.

## უსაფრთხოების საზღვრები

- გამოიყენება შემთხვევით გენერირებული QA პაროლი და მხოლოდ `127.0.0.1`-ზე მიბმული პორტი.
- Production credentials ან Production database არ გამოიყენება.
- ტესტი მხოლოდ დროებით QA მონაცემებს ქმნის.
- ტესტის დასრულების შემდეგ კონტეინერი იშლება; მისი მონაცემებიც იკარგება.
- რეალური PostgreSQL PASS ჩაითვლება მხოლოდ მაშინ, როცა `npm run test:postgres` დასრულდება `1 pass / 0 fail / 0 skip` შედეგით.