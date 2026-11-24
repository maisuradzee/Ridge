# RIDGE — Production TLS ingress და API rate limits

**სტატუსი:** deployment template + CI syntax validation. ეს არ არის უკვე გაშვებული Production ინფრასტრუქტურა.

## 1. ქსელური სქემა

    Player / Dedicated Server / Operator
                     |
                  HTTPS :443
                     |
           Nginx TLS termination
           - TLS 1.2 / TLS 1.3
           - per-IP rate limits
           - control-plane IP allowlist
           - safe access logging
                     |
              HTTP loopback only
                     |
            RIDGE Foundation API
              127.0.0.1:8787
                     |
          PostgreSQL (private only)

RIDGE API პირდაპირ ინტერნეტში არ უნდა გამოჩნდეს. Nginx არის ერთადერთი საჯარო API ingress; Node listener რჩება loopback-ზე. PostgreSQL-ის პორტი 5432 არ გამოაქვეყნო საჯარო ინტერფეისზე.

## 2. DNS და TLS სერტიფიკატი

1. შექმენი API-სთვის ცალკე DNS სახელი, მაგალითად api.example.com, და მიუთითე სერვერის საჯარო IP-ზე.
2. დააყენე Nginx და Certbot.
3. სერტიფიკატის მიღებამდე შეაჩერე Nginx, რათა Standalone ACME challenge-მა 80 პორტი გამოიყენოს:

       sudo systemctl stop nginx
       sudo certbot certonly --standalone -d api.example.com
       sudo systemctl start nginx

4. deploy/production/nginx-ridge.conf-ში ორივე ადგილას შეცვალე ridge-api.example.com შენი რეალური დომენით. გადაამოწმე certificate/key paths.
5. დააკოპირე კონფიგურაცია:

       sudo cp deploy/production/nginx-ridge.conf /etc/nginx/conf.d/ridge-api.conf
       sudo rm -f /etc/nginx/sites-enabled/default
       sudo nginx -t
       sudo systemctl reload nginx

HTTP :80 განზრახ აბრუნებს დახურვის პასუხს 444; ის არ აკეთებს HTTP-to-HTTPS redirect-ს. ამით OIDC Bearer token-იანი მოთხოვნა plaintext HTTP-ზე არ მუშავდება. თამაშის კლიენტსა და API-ს შორის გამოიყენე პირდაპირი HTTPS URL.

სერტიფიკატის განახლების შემდეგ Nginx reload უნდა შესრულდეს. Certbot deploy hook:

       sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
       sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-ridge-nginx.sh >/dev/null <<'EOF'
       #!/bin/sh
       systemctl reload nginx
       EOF
       sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-ridge-nginx.sh
       sudo certbot renew --dry-run

## 3. Backend Production კონფიგურაცია

Backend environment ფაილი შეინახე repository-ს გარეთ, მაგალითად /etc/ridge/ridge-api.env; წვდომა ჰქონდეს მხოლოდ root-სა და RIDGE service account-ს. არ დაამატო token-ები GitHub Actions-ის ჩვეულებრივ CI-ში ან Unreal client build-ში.

სავალდებულო კონფიგურაციის ფორმა:

       RIDGE_ENV=production
       RIDGE_HOST=127.0.0.1
       PORT=8787
       RIDGE_STORAGE=postgres
       RIDGE_TRUST_PROXY=true

       DATABASE_URL=postgresql://ridge_backend:REDACTED@127.0.0.1:5432/ridge_prod
       PGSSL=disable
       PG_POOL_MAX=20

       RIDGE_OIDC_ISSUER=https://identity.example.com/
       RIDGE_OIDC_AUDIENCE=ridge-game
       RIDGE_OIDC_JWKS_URL=https://identity.example.com/.well-known/jwks.json

       RIDGE_GATEWAY_TOKEN=REPLACE_WITH_RANDOM_SECRET
       RIDGE_SERVER_PROVISIONING_TOKEN=REPLACE_WITH_SEPARATE_RANDOM_SECRET

- RIDGE_TRUST_PROXY=true ჩართე მხოლოდ მაშინ, როცა Node API მიუწვდომელია საჯარო ქსელიდან და მის წინ სანდო Nginx დგას. მოცემული შაბლონი Node-ს loopback-ზე აბამს და Nginx-ს მხოლოდ 127.0.0.1:8787-ზე აკავშირებს.
- PostgreSQL სხვა ჰოსტზე თუა, გამოიყენე TLS (PGSSL=verify-full) და შესაბამისი CA trust. PGSSL=disable მხოლოდ იმავე ჰოსტზე loopback/private DB კავშირისთვის დატოვე.
- Production-ში საერთო RIDGE_SERVER_EVENT_TOKEN fallback არ გამოიყენო. თითოეულ Dedicated Server-ს უნდა ჰქონდეს ცალკე provisioned credential; provisioning token მხოლოდ orchestrator-ს ეკუთვნის.
- RIDGE_GATEWAY_TOKEN და RIDGE_SERVER_PROVISIONING_TOKEN განსხვავებული, შემთხვევითი საიდუმლოებები უნდა იყოს.
- OIDC issuer, audience და JWKS URL რეალური Provider tenant-ის მნიშვნელობებით შეავსე.
- Migration-ები 001–006 ჯერ ცალკე migration role-ით გაატარე. Backend runtime role-ს მიანიჭე მხოლოდ საჭირო მინიმალური უფლებები. სერვისის გაშვება ავტომატურად არ ნიშნავს, რომ migration-ები შესრულებულია.

მაგალითად, environment ფაილის დაცვა:

       sudo install -d -m 750 -o root -g ridge /etc/ridge
       sudo chown root:ridge /etc/ridge/ridge-api.env
       sudo chmod 640 /etc/ridge/ridge-api.env

RIDGE API-ს systemd service-ში გამოიყენე EnvironmentFile=/etc/ridge/ridge-api.env და გაუშვი backend/src/server.mjs. Node-ის გაშვებისას სწორედ ეს გარემოს ცვლადები უნდა იყოს ხელმისაწვდომი. Production secrets არ ჩაწერო command-line arguments-ში.

## 4. Nginx-ის დაცვის წესები

deploy/production/nginx-ridge.conf შეიცავს საწყის, შესაფასებელ rate-limit ზღვარს:

| Route group | საწყისი ზღვარი თითო source IP-ზე | დანიშნულება |
|---|---:|---|
| General API | 100 მოთხოვნა/წმ, burst 500 | ჩვეულებრივი API |
| Public OIDC session | 600 მოთხოვნა/წთ, burst 500 | session issuance-ის დაცვა |
| Control plane | 30 მოთხოვნა/წმ, burst 100 | credential issuance/revocation |
| Dedicated Server internal | 300 მოთხოვნა/წმ, burst 500 | heartbeat/session/game-server ოპერაციები |

ეს არის საწყისი edge policy და არა გაზომილი Production capacity. Limits უნდა გადაიხედოს რეალური login burst-ისა და shard traffic-ის მიხედვით. Rate limit source-IP-ზეა; ერთ NAT მისამართს მიღმა არსებული ბევრი მოთამაშე საერთო ლიმიტს იყოფს. ზედმეტი 429 პასუხებისას ზღვარი გაზომვებით შეცვალე და არა ლიმიტის სრულად გამორთვით.

 /v1/control/* მხოლოდ loopback/RFC1918/IPv6 ULA source-ებს იღებს. Orchestrator სხვა private subnet-შია თუ hosted control-plane იყენებს სხვა მისამართების დიაპაზონს, დაამატე მხოლოდ მისი რეალური private CIDR. არ დაამატო ფართო public CIDR. Dedicated Server internal routes კვლავ მოითხოვს თითო-instance credential-ს.

Access log განზრახ წერს მხოლოდ HTTP method-სა და URI path-ს; query string, Authorization header და request body არ ილოგება. არ დაამატო ticket ან credential log-ში. /ready საჯარო ingress-ზე დამალულია; readiness შეამოწმე უშუალოდ სერვერიდან.

თუ Nginx-ს წინ კიდევ ერთი load balancer/CDN დგას, ეს შაბლონი უცვლელად არ გამოიყენო: ჯერ ზუსტად განსაზღვრე trusted proxy CIDR და Real-IP მოდულის წესები. არასოდეს ენდო კლიენტის მიერ გამოგზავნილ X-Forwarded-For მნიშვნელობას.

## 5. მიღების შემოწმება

- sudo nginx -t წარმატებულია.
- http://api.example.com/health API პასუხს არ აბრუნებს; plaintext listener კავშირს ხურავს.
- https://api.example.com/ready აბრუნებს 404-ს.
- https://api.example.com/health აბრუნებს API health JSON-ს.
- HTTPS certificate hostname ემთხვევა DNS-ს და curl-ს certificate validation-ის გამორთვა არ სჭირდება.
- ინტერნეტიდან 127.0.0.1:8787 და PostgreSQL :5432 მიუწვდომელია.
- განმეორებით gateway მოთხოვნებზე rate-limit ზღვრის გადაცილებისას Nginx აბრუნებს HTTP 429-ს.
- Control-plane endpoint-ები public source IP-დან მიუწვდომელია.
- API startup წარმატებულია RIDGE_ENV=production, RIDGE_STORAGE=postgres, OIDC და provisioning secret-ებით.

## 6. რაც ჯერ არ არის დახურული

ეს ბლოკი იცავს API ingress-ს. ის არ შიფრავს ცალკე Unreal Dedicated Server game transport-ს, რომელშიც ამჟამინდელ source flow-ში join ticket გადაეცემა. Nginx TLS-ის ჩართვა არ ნიშნავს, რომ UE game connection უკვე დაშიფრულია.

ასევე ცალკე რჩება:
- UE 5.8 Windows UBT/UHT Game + Editor + Dedicated Server build;
- Editor PIE და ორი რეალური client-ის replication/reconnect;
- game transport encryption-ის იმპლემენტაცია და runtime verification;
- Provider authorization-code + PKCE UI, refresh და account recovery;
- 25/50/100 Unreal-client profile და რეალური 500-CCU soak;
- production domain, certificate, database, secret manager და orchestrator-ის ფაქტობრივი provisioning.

ამ ფაილების დამატება მხოლოდ deployment path-ს ამზადებს; არც Production deployment-ს და არც ზემოთ ჩამოთვლილ runtime gate-ებს შესრულებულად არ აცხადებს.
