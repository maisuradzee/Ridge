# RIDGE — Unreal Dedicated Server რეგისტრაცია და heartbeat

**ეტაპი:** Stage 5 / UE control-plane wiring  
**Engine target:** Unreal Engine 5.8  
**მდგომარეობა:** Source wiring დამატებულია; რეალური UBT/UHT/PIE/Server execution კვლავ ცალკე acceptance gate-ია.

## 1. რა ხდება ავტომატურად

როდესაც ARidgeGameMode იწყებს მუშაობას server/standalone world-ში:

1. იღებს URidgeBackendSubsystem-ს GameInstance-იდან.
2. აგზავნის POST /v1/internal/shards/register მოთხოვნას.
3. რეგისტრაციის წარმატების შემდეგ ყოველ 15 წამში აგზავნის heartbeat-ს.
4. Heartbeat შეიცავს GetNumPlayers()-ს და ready სტატუსს.
5. თუ API ან ქსელი დროებით მიუწვდომელია, შემდეგ heartbeat ციკლზე registration ხელახლა სცადება.
6. EndPlay-ზე timer იწმინდება და სერვერი აგზავნის offline heartbeat-ს.

Registry-ის heartbeat freshness window 45 წამია; 15-წამიანი cadence განზრახ ტოვებს ორ retry ინტერვალს transient failure-ისთვის.

GetNumPlayers() ითვლის აქტიურ მოთამაშეებს და არ მოიცავს spectator-ებს. ეს მნიშვნელობა shard registry-ში მხოლოდ advertised live player count-ად გამოიყენება.

## 2. Development გარემოს კონფიგურაცია

PowerShell-ში, Dedicated Server-ის გაშვებამდე:

    $env:RIDGE_ENV = "development"
    $env:RIDGE_API_BASE_URL = "http://127.0.0.1:8787"
    $env:RIDGE_SERVER_EVENT_TOKEN = "<development server token>"
    $env:RIDGE_SERVER_ID = "saburtalo-dev-a"
    $env:RIDGE_SERVER_REGION = "ge-tbilisi"
    $env:RIDGE_SERVER_HOST = "127.0.0.1"
    $env:RIDGE_SERVER_PORT = "7777"
    $env:RIDGE_SERVER_MAX_PLAYERS = "100"
    $env:RIDGE_PROTOCOL_VERSION = "ridge-0.6"

RIDGE_SERVER_ID არის მხოლოდ human-readable process label. C++ subsystem მას ახალ GUID-ს ამატებს, რათა ყოველ process boot-ზე უნიკალური instance ID შეიქმნას. ერთსა და იმავე აქტიურ instance ID-ს registry ხელახლა არ იღებს.

RIDGE_SERVER_HOST არის მისამართი, რომელსაც კლიენტი გამოიყენებს Dedicated Server-თან დასაკავშირებლად — ეს არ არის Backend API-ის მისამართი. 127.0.0.1 გამოდგება მხოლოდ იმ შემთხვევისთვის, როცა game client და server ერთ კომპიუტერზეა. LAN ტესტისთვის მიუთითეთ server კომპიუტერის LAN მისამართი.

## 3. Production-ის აუცილებელი პირობები

Production-ში ეს მნიშვნელობები აუცილებლად გარემოდან უნდა მოვიდეს:

- RIDGE_ENV=production
- RIDGE_API_BASE_URL=https://backend-domain
- RIDGE_SERVER_HOST=<publicly reachable DNS name or IP>
- RIDGE_SERVER_EVENT_TOKEN=<secret-store supplied token>

Production რეჟიმში:
- HTTPS-ის გარეშე API URL უარყოფილია; shared server token არ გაიგზავნება plaintext HTTP-ზე.
- API URL-ის default localhost მნიშვნელობა აღარ გამოიყენება.
- RIDGE_SERVER_HOST სავალდებულოა; localhost და 127.x.x.x loopback მისამართები უარყოფილია.
- API registry-ის advertised port უნდა ემთხვეოდეს რეალურ game transport port-სა და firewall/NAT mapping-ს.
- RIDGE_SERVER_EVENT_TOKEN არ უნდა მოთავსდეს Default*.ini, game assets, client config, command line ან log-ში.

მიმდინარე backend ჯერ იყენებს ერთ shared internal server token-ს. Production გაშვებამდე საჭიროა per-server credentials, rotation/revocation და least-privilege authorization.

## 4. Compile და runtime პროცედურა

Windows გარემოში Unreal Engine 5.8-ის ზუსტი install path მიუთითეთ:

    $env:RIDGE_UE_ROOT = "D:\Epic Games\UE_5.8"
    .\Tools\BotLab\Run-UE58BotLabBuild.ps1 -BuildDedicatedServer

შემდეგ გახსენით RIDGE.uproject Unreal Engine 5.8 Editor-ში, გამოიყენეთ ცალკე QA map და გაუშვით Dedicated Server + მინიმუმ ორი client.

შეამოწმეთ:
- Server startup-ის შემდეგ ridge.dedicated_servers-ში ერთი ახალი server instance;
- heartbeat-ის 15-წამიანი cadence და მოთამაშეების სწორი რაოდენობა;
- 45 წამზე ძველი heartbeat-ის შემდეგ allocator-მა shard აღარ უნდა აირჩიოს;
- EndPlay-ის შემდეგ server status უნდა გახდეს offline;
- client build/PIE client-ში RIDGE_SERVER_EVENT_TOKEN არ უნდა ჩაიტვირთოს.

Static CI ამოწმებს მხოლოდ source contract-ს. ის არ ადასტურებს C++ compilation/UHT/PIE, რეალურ UDP reachability-ს, reconnect-ს ან actor replication-ს.

## 5. ჯერ კიდევ დაუმთავრებელი integration

ამ increment-ში Dedicated Server-ს შეუძლია თავის თავზე registration/heartbeat lifecycle-ის მართვა. თუმცა player-facing flow ჯერ ბოლომდე არ არის მიბმული:
- verified player authentication და signed join ticket;
- PreLogin/PostLogin-ში player session allocation და server-scoped claim;
- disconnect-ზე release და crash recovery;
- cross-region/cross-shard transfer;
- per-server credentials და credential rotation.

სესიის registry ამ ოპერაციებისთვის უკვე არსებობს. მისი public API მხოლოდ trusted internal server token-ით არის ხელმისაწვდომი; client-მა პირდაპირ არ უნდა გამოიძახოს.

## 6. მიღების კრიტერიუმები

- [ ] UE 5.8 Editor target + UHT compile PASS
- [ ] RIDGEServer target compile PASS
- [ ] Dedicated Server register API returns HTTP 201
- [ ] Heartbeat arrives every 15 seconds
- [ ] Stale shard is excluded from allocation after 45 seconds
- [ ] EndPlay marks shard offline
- [ ] Two clients can connect and see authoritative replicated movement
- [ ] Client cannot access server token or internal shard endpoints

**მდგომარეობა:** code wiring committed/CI static checks pending. Production readiness is not claimed.
