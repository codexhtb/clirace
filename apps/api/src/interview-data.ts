export type InterviewDifficulty = 'Easy' | 'Medium' | 'Hard';
export type InterviewTopic =
  | 'linux-fundamentals' | 'files-text' | 'processes-performance'
  | 'networking' | 'permissions-security' | 'systemd-services'
  | 'storage-filesystems' | 'bash-shell' | 'git-containers';

export interface InterviewSandbox {
  hint: string;
  setupScript: string;
  checkScript: string;
}

export interface InterviewTask {
  slug: string;
  title: string;
  description: string;
  topic: InterviewTopic;
  category: 'linux' | 'bash' | 'networking' | 'systemd' | 'docker' | 'git';
  difficulty: InterviewDifficulty;
  type: 'quick' | 'real_shell';
  solution: string;
  alternatives: readonly string[];
  explanation: string;
  tags: readonly string[];
  sandbox?: InterviewSandbox;
}

type Spec = readonly [
  InterviewTopic, InterviewDifficulty, InterviewTask['category'], string, string,
  string, readonly string[], string, readonly string[], InterviewSandbox?,
];

const specs: readonly Spec[] = [
  // Linux fundamentals — 15 (5 Easy / 7 Medium / 3 Hard)
  ['linux-fundamentals','Easy','linux','Путь под ногами','Выведите абсолютный путь текущего каталога.','pwd',[],'pwd печатает полный путь рабочего каталога.',['pwd','paths']],
  ['linux-fundamentals','Easy','linux','Скрытые тоже считаются','Покажите все файлы текущего каталога, включая скрытые.','ls -la',['ls -al'],'Ключ -a включает скрытые имена, -l даёт подробный список.',['ls','files']],
  ['linux-fundamentals','Easy','linux','Кто выполняет команду','Выведите имя текущего пользователя.','whoami',['id -un'],'whoami и id -un возвращают эффективное имя пользователя.',['users','identity']],
  ['linux-fundamentals','Easy','linux','Версия ядра','Выведите версию запущенного ядра Linux.','uname -r',[],'uname -r показывает release текущего ядра.',['kernel','uname']],
  ['linux-fundamentals','Easy','linux','Возвращение в HOME','Перейдите в домашний каталог текущего пользователя.','cd ~',['cd'],'cd без аргументов и cd ~ открывают домашний каталог.',['cd','paths']],
  ['linux-fundamentals','Medium','linux','Архитектура машины','Выведите аппаратную архитектуру системы.','uname -m',['arch'],'uname -m показывает архитектуру ядра, например x86_64.',['kernel','architecture']],
  ['linux-fundamentals','Medium','linux','Переменная окружения','Выведите значение переменной PATH без лишнего текста.','printf "%s\\n" "$PATH"',['echo "$PATH"'],'PATH содержит каталоги поиска исполняемых файлов.',['environment','path']],
  ['linux-fundamentals','Medium','linux','Где лежит curl','Найдите исполняемый файл curl через PATH.','command -v curl',['which curl'],'command -v — переносимый способ узнать, какая команда будет запущена.',['path','commands']],
  ['linux-fundamentals','Medium','linux','Информация о системе','Покажите содержимое файла с идентификацией дистрибутива.','cat /etc/os-release',[],'/etc/os-release — стандартный источник имени и версии Linux-дистрибутива.',['os-release','distro']],
  ['linux-fundamentals','Medium','linux','Последние входы','Покажите последние входы пользователей в систему.','last',['last -n 10'],'last читает журнал входов wtmp.',['users','audit']],
  ['linux-fundamentals','Medium','linux','Текущая оболочка','Выведите путь оболочки, заданной текущему процессу переменной SHELL.','printf "%s\\n" "$SHELL"',['echo "$SHELL"'],'SHELL хранит путь предпочтительной оболочки пользователя.',['shell','environment']],
  ['linux-fundamentals','Medium','linux','Размер каталога','Покажите суммарный размер /var/log в удобном для чтения виде.','du -sh /var/log',['du -hs /var/log'],'du -s суммирует, а -h форматирует размер.',['du','filesystem']],
  ['linux-fundamentals','Hard','linux','Новый рабочий каталог','Создайте /workspace/interview и перейдите в него.','mkdir -p /workspace/interview && cd /workspace/interview',[],'mkdir -p безопасно создаёт путь, а && меняет каталог только после успеха.',['mkdir','cd'],{hint:'mkdir -p /workspace/interview && cd /workspace/interview',setupScript:'mkdir -p /workspace',checkScript:'[ -d /workspace/interview ]'}],
  ['linux-fundamentals','Hard','linux','Возраст загрузки','Покажите время запуска системы в читаемом формате.','uptime -s',['who -b'],'uptime -s печатает точное время старта системы.',['uptime','boot']],
  ['linux-fundamentals','Hard','linux','Лимит открытых файлов','Покажите мягкий лимит открытых файлов текущей оболочки.','ulimit -n',[],'ulimit -n показывает soft limit файловых дескрипторов процесса.',['limits','fd']],

  // Files and text — 15 (5 / 7 / 3)
  ['files-text','Easy','bash','Первые пять строк','Выведите первые 5 строк /workspace/app.log.','head -n 5 /workspace/app.log',['head -5 /workspace/app.log'],'head ограничивает вывод началом файла.',['head','logs']],
  ['files-text','Easy','bash','Последняя строка','Выведите последнюю строку /workspace/app.log.','tail -n 1 /workspace/app.log',['tail -1 /workspace/app.log'],'tail -n 1 оставляет последнюю запись.',['tail','logs']],
  ['files-text','Easy','bash','Найти ERROR','Покажите строки с ERROR в /workspace/app.log.','grep ERROR /workspace/app.log',['grep "ERROR" /workspace/app.log'],'grep отбирает строки по шаблону.',['grep','logs']],
  ['files-text','Easy','bash','Длина списка','Посчитайте строки в /workspace/users.txt.','wc -l /workspace/users.txt',['cat /workspace/users.txt | wc -l'],'wc -l считает символы новой строки.',['wc','text']],
  ['files-text','Easy','bash','Копия конфига','Скопируйте /workspace/app.conf в /workspace/app.conf.bak.','cp /workspace/app.conf /workspace/app.conf.bak',[],'cp создаёт независимую копию файла.',['cp','backup'],{hint:'cp /workspace/app.conf /workspace/app.conf.bak',setupScript:"mkdir -p /workspace; printf 'port=8080\\n' > /workspace/app.conf",checkScript:"cmp -s /workspace/app.conf /workspace/app.conf.bak"}],
  ['files-text','Medium','bash','Ошибки без регистра','Найдите ERROR в /workspace/app.log без учёта регистра и покажите номера строк.','grep -in ERROR /workspace/app.log',['grep -ni ERROR /workspace/app.log'],'-i игнорирует регистр, -n добавляет номер строки.',['grep','logs']],
  ['files-text','Medium','bash','Уникальные адреса','Выведите уникальные IP из первого столбца /workspace/access.log в сортированном виде.','cut -d" " -f1 /workspace/access.log | sort -u',["awk '{print $1}' /workspace/access.log | sort -u"],'Сначала извлекается поле IP, затем sort -u сортирует и удаляет повторы.',['cut','sort','logs']],
  ['files-text','Medium','bash','Заменить порт','Замените port=8080 на port=9090 в /workspace/app.conf.','sed -i "s/^port=8080$/port=9090/" /workspace/app.conf',[],'sed -i изменяет файл на месте, якоря защищают от случайных совпадений.',['sed','config'],{hint:'sed -i "s/^port=8080$/port=9090/" /workspace/app.conf',setupScript:"mkdir -p /workspace; printf 'host=localhost\\nport=8080\\n' > /workspace/app.conf",checkScript:"grep -qx 'port=9090' /workspace/app.conf && ! grep -q 'port=8080' /workspace/app.conf"}],
  ['files-text','Medium','bash','Большие файлы','Найдите обычные файлы больше 100 МБ внутри /var.','find /var -type f -size +100M',['find /var -size +100M -type f'],'find фильтрует обычные файлы по размеру, не полагаясь на формат ls.',['find','size']],
  ['files-text','Medium','bash','Новые логи','Найдите .log файлы в /var/log, изменённые за последние сутки.','find /var/log -type f -name "*.log" -mtime -1',[],'-mtime -1 означает менее одного 24-часового интервала.',['find','logs']],
  ['files-text','Medium','bash','Топ IP','Покажите 5 самых частых IP из первого столбца /workspace/access.log.','awk "{print $1}" /workspace/access.log | sort | uniq -c | sort -nr | head -n 5',["cut -d' ' -f1 /workspace/access.log | sort | uniq -c | sort -nr | head -n 5"],'Сортировка группирует IP, uniq -c считает, вторая сортировка ставит лидеров первыми.',['awk','uniq','logs']],
  ['files-text','Medium','bash','Архив журналов','Создайте gzip-архив /workspace/logs.tar.gz из каталога /workspace/logs.','tar -czf /workspace/logs.tar.gz -C /workspace logs',['tar czf /workspace/logs.tar.gz -C /workspace logs'],'-C делает структуру архива предсказуемой без абсолютного пути.',['tar','backup'],{hint:'tar -czf /workspace/logs.tar.gz -C /workspace logs',setupScript:"mkdir -p /workspace/logs; printf 'ok\\n' > /workspace/logs/app.log",checkScript:"tar -tzf /workspace/logs.tar.gz 2>/dev/null | grep -qx 'logs/app.log'"}],
  ['files-text','Hard','bash','503 и только IP','Найдите IP клиентов с HTTP 503 в /workspace/access.log, уникально и по алфавиту.','awk "$9 == 503 {print $1}" /workspace/access.log | sort -u',[],'awk проверяет поле статуса, а sort -u нормализует результат.',['awk','http','logs']],
  ['files-text','Hard','bash','Атомарная замена','Запишите enabled=true в /workspace/feature.conf через временный файл и атомарный mv.','printf "enabled=true\\n" > /workspace/feature.conf.tmp && mv /workspace/feature.conf.tmp /workspace/feature.conf',[],'mv в пределах файловой системы атомарно заменяет целевой файл.',['atomic','config'],{hint:'Сначала запишите .tmp, затем используйте mv.',setupScript:"mkdir -p /workspace; printf 'enabled=false\\n' > /workspace/feature.conf",checkScript:"[ \"$(cat /workspace/feature.conf 2>/dev/null)\" = 'enabled=true' ] && [ ! -e /workspace/feature.conf.tmp ]"}],
  ['files-text','Hard','bash','Битые ссылки','Найдите символические ссылки без существующей цели внутри /workspace.','find /workspace -xtype l',['find /workspace -type l ! -exec test -e {} ";" -print'],'-xtype l при разыменовании выбирает именно битые символические ссылки.',['find','symlink']],

  // Processes and performance — 10 (3 / 5 / 2)
  ['processes-performance','Easy','linux','Все процессы','Покажите полный список процессов всех пользователей.','ps aux',['ps -ef'],'ps aux и ps -ef дают полный снимок процессов.',['ps','processes']],
  ['processes-performance','Easy','linux','Жив ли nginx','Найдите PID процессов с точным именем nginx.','pgrep -x nginx',['pidof nginx'],'pgrep -x исключает частичные совпадения имени.',['pgrep','processes']],
  ['processes-performance','Easy','linux','Остановить PID','Завершите процесс с PID 4242 обычным сигналом TERM.','kill 4242',['kill -TERM 4242'],'SIGTERM даёт процессу возможность корректно завершиться.',['signals','processes']],
  ['processes-performance','Medium','linux','Топ по памяти','Покажите пять процессов с наибольшей долей памяти.','ps aux --sort=-%mem | head -n 6',['ps -eo pid,comm,%mem --sort=-%mem | head -n 6'],'Сортировка по убыванию %MEM ставит потребителей памяти первыми; одна строка — заголовок.',['ps','memory']],
  ['processes-performance','Medium','linux','Топ по CPU','Покажите PID, команду и CPU процессов, отсортировав по убыванию CPU.','ps -eo pid,comm,%cpu --sort=-%cpu',[],'Пользовательский формат ps оставляет нужные поля и сортирует их на стороне ps.',['ps','cpu']],
  ['processes-performance','Medium','linux','Понизить приоритет','Измените nice процесса 4242 на 10.','renice 10 -p 4242',['renice -n 10 -p 4242'],'renice меняет приоритет уже работающего процесса.',['nice','processes']],
  ['processes-performance','Medium','linux','Дерево процессов','Покажите процессы деревом вместе с PID.','pstree -p',['ps -ejH'],'Дерево помогает увидеть родителей, потомков и неожиданные форки.',['pstree','processes']],
  ['processes-performance','Medium','linux','Открытые файлы процесса','Покажите открытые файлы процесса 4242.','lsof -p 4242',['ls -l /proc/4242/fd'],'lsof связывает файловые дескрипторы с их объектами.',['lsof','fd']],
  ['processes-performance','Hard','linux','Кто держит файл','Найдите процессы, использующие /workspace/app.log.','lsof /workspace/app.log',['fuser /workspace/app.log'],'lsof показывает PID и тип открытого дескриптора для файла.',['lsof','debug']],
  ['processes-performance','Hard','linux','Системные вызовы','Подключите strace к PID 4242 и отслеживайте только файловые вызовы.','strace -p 4242 -e trace=file',['strace -e trace=file -p 4242'],'Фильтр trace=file убирает шум и оставляет операции с путями.',['strace','debug']],

  // Networking — 15 (4 / 8 / 3)
  ['networking','Easy','networking','Сетевые адреса','Покажите краткий список интерфейсов и IP-адресов.','ip -br addr',['ip addr'],'ip -br addr удобен для быстрого обзора адресов.',['ip','interfaces']],
  ['networking','Easy','networking','Маршруты','Покажите таблицу маршрутизации.','ip route',['route -n'],'ip route показывает выбранные ядром шлюзы и сети.',['ip','routing']],
  ['networking','Easy','networking','Проверка DNS','Получите IP-адрес example.com через DNS.','dig +short example.com',['getent ahosts example.com','host example.com'],'dig +short оставляет только краткий DNS-ответ.',['dns','dig']],
  ['networking','Easy','networking','HTTP-заголовки','Получите только HTTP-заголовки https://example.com.','curl -I https://example.com',['curl --head https://example.com'],'HEAD-запрос проверяет доступность без загрузки тела.',['curl','http']],
  ['networking','Medium','networking','TCP на приёме','Перечислите TCP-порты в LISTEN вместе с PID программ-владельцев.','ss -ltnp',['ss -plnt'],'ss -ltnp показывает listen, TCP, числа и владельцев.',['ss','tcp']],
  ['networking','Medium','networking','Хозяин порта 8080','Определите программу, которая принимает TCP-соединения на локальном порту 8080.','ss -ltnp "sport = :8080"',['lsof -iTCP:8080 -sTCP:LISTEN'],'Фильтр ss сразу ограничивает результат нужным локальным портом.',['ss','ports']],
  ['networking','Medium','networking','Путь пакетов','Покажите сетевой маршрут до example.com без DNS-резолвинга узлов.','traceroute -n example.com',['tracepath -n example.com'],'-n ускоряет диагностику и не смешивает её с проблемами DNS.',['traceroute','routing']],
  ['networking','Medium','networking','Проверка порта','Проверьте TCP-подключение к example.com:443 с таймаутом 3 секунды.','nc -zvw3 example.com 443',['timeout 3 bash -c "</dev/tcp/example.com/443"'],'nc в zero-I/O режиме проверяет установление TCP-соединения.',['nc','tcp']],
  ['networking','Medium','networking','Какой шлюз выбран','Покажите маршрут, который ядро выберет для 1.1.1.1.','ip route get 1.1.1.1',[],'ip route get учитывает реальные правила и показывает интерфейс и исходный адрес.',['ip','routing']],
  ['networking','Medium','networking','DNS через конкретный сервер','Запросите A-запись example.com у DNS-сервера 1.1.1.1.','dig @1.1.1.1 example.com A',['nslookup example.com 1.1.1.1'],'Явный сервер отделяет проблему локального resolver от внешнего DNS.',['dns','dig']],
  ['networking','Medium','networking','Скачать с ошибкой','Скачайте URL в /tmp/body и заставьте curl вернуть ошибку при HTTP 4xx/5xx.','curl -fSLo /tmp/body https://example.com',['curl --fail --show-error --location -o /tmp/body https://example.com'],'-f превращает HTTP-ошибку в ненулевой код, -S показывает причину, -L следует редиректам.',['curl','http']],
  ['networking','Medium','networking','Соседи в сети','Покажите таблицу ARP/ND соседей ядра.','ip neigh',['arp -n'],'ip neigh работает и для IPv4 ARP, и для IPv6 NDP.',['ip','arp']],
  ['networking','Hard','networking','Захват DNS','Захватите на любом интерфейсе первые 20 пакетов DNS без преобразования имён.','tcpdump -ni any port 53 -c 20',['tcpdump -n -i any -c 20 port 53'],'Числовой режим избегает рекурсивного DNS-трафика во время диагностики.',['tcpdump','dns']],
  ['networking','Hard','networking','HTTP с таймингами','Покажите код ответа и общее время запроса, не выводя тело.','curl -sS -o /dev/null -w "%{http_code} %{time_total}\\n" https://example.com',[],'write-out выдаёт измерения curl независимо от тела ответа.',['curl','latency']],
  ['networking','Hard','networking','MTU маршрута','Проверьте максимальный размер ICMP до 1.1.1.1 без фрагментации, начав с payload 1472.','ping -M do -s 1472 1.1.1.1',['ping -c 4 -M do -s 1472 1.1.1.1'],'DF и управляемый payload помогают выявить black-hole MTU.',['ping','mtu']],

  // Permissions and security — 10 (3 / 5 / 2)
  ['permissions-security','Easy','linux','Приватный ключ','Установите права 600 на /workspace/id_ed25519.','chmod 600 /workspace/id_ed25519',[],'600 оставляет чтение и запись только владельцу.',['chmod','ssh'],{hint:'chmod 600 /workspace/id_ed25519',setupScript:"mkdir -p /workspace; printf 'private\\n' > /workspace/id_ed25519; chmod 644 /workspace/id_ed25519",checkScript:"[ \"$(stat -c %a /workspace/id_ed25519)\" = 600 ]"}],
  ['permissions-security','Easy','linux','Исполняемый скрипт','Добавьте владельцу право исполнения /workspace/deploy.sh.','chmod u+x /workspace/deploy.sh',[],'Символьный режим меняет только нужный бит владельца.',['chmod','scripts'],{hint:'chmod u+x /workspace/deploy.sh',setupScript:"mkdir -p /workspace; printf '#!/bin/sh\\n' > /workspace/deploy.sh; chmod 644 /workspace/deploy.sh",checkScript:'[ -n "$(find /workspace/deploy.sh -maxdepth 0 -perm -u=x -print -quit)" ]'}],
  ['permissions-security','Easy','linux','Владелец файла','Покажите владельца и группу /workspace/app.conf.','stat -c "%U %G" /workspace/app.conf',['ls -l /workspace/app.conf'],'stat с форматом даёт стабильный машинно-читаемый результат.',['stat','ownership']],
  ['permissions-security','Medium','linux','Права каталога SSH','Установите права 700 на /workspace/.ssh.','chmod 700 /workspace/.ssh',[],'700 запрещает другим читать и просматривать каталог ключей.',['chmod','ssh'],{hint:'chmod 700 /workspace/.ssh',setupScript:'mkdir -p /workspace/.ssh; chmod 755 /workspace/.ssh',checkScript:'[ "$(stat -c %a /workspace/.ssh)" = 700 ]'}],
  ['permissions-security','Medium','linux','Найти доступные всем','Найдите обычные файлы в /workspace, доступные на запись всем.','find /workspace -type f -perm -0002',['find /workspace -type f -perm /o=w'],'Проверка бита o+w выявляет риск изменения файла любым пользователем.',['find','permissions']],
  ['permissions-security','Medium','linux','Общая группа','Установите SGID-бит на /workspace/shared, сохранив остальные права.','chmod g+s /workspace/shared',[],'SGID заставляет новые файлы наследовать группу каталога.',['chmod','sgid'],{hint:'chmod g+s /workspace/shared',setupScript:'mkdir -p /workspace/shared; chmod 775 /workspace/shared',checkScript:'[ $(( $(stat -c %a /workspace/shared) / 1000 )) -ge 2 ]'}],
  ['permissions-security','Medium','linux','Безопасный общий tmp','Установите sticky bit на /workspace/dropbox.','chmod +t /workspace/dropbox',[],'Sticky bit разрешает удалять записи только их владельцам и владельцу каталога.',['chmod','sticky'],{hint:'chmod +t /workspace/dropbox',setupScript:'mkdir -p /workspace/dropbox; chmod 777 /workspace/dropbox',checkScript:'[ $(( $(stat -c %a /workspace/dropbox) / 1000 )) -eq 1 ]'}],
  ['permissions-security','Medium','linux','Маска новых файлов','Установите umask 027 для текущей оболочки.','umask 027',[],'027 создаёт файлы без доступа для остальных и без записи для группы.',['umask','permissions']],
  ['permissions-security','Hard','linux','Аудит SUID','Найдите SUID-файлы в /usr на текущей файловой системе.','find /usr -xdev -type f -perm -4000',['find /usr -xdev -type f -perm /4000'],'-xdev не уходит в другие файловые системы, -4000 проверяет SUID.',['find','suid']],
  ['permissions-security','Hard','linux','ACL для аудитора','Дайте пользователю auditor право чтения /workspace/report.txt через ACL.','setfacl -m u:auditor:r /workspace/report.txt',[],'ACL выдаёт точечное право без смены владельца или общей группы.',['acl','security']],

  // systemd and services — 10 (2 / 6 / 2)
  ['systemd-services','Easy','systemd','Статус nginx','Покажите подробный статус службы nginx.','systemctl status nginx',['systemctl --no-pager status nginx'],'status объединяет состояние, PID и последние сообщения журнала.',['systemctl','services']],
  ['systemd-services','Easy','systemd','Перезапуск службы','Перезапустите службу nginx.','sudo systemctl restart nginx',['systemctl restart nginx'],'restart последовательно останавливает и запускает unit.',['systemctl','services']],
  ['systemd-services','Medium','systemd','Автозапуск сейчас','Включите nginx в автозапуск и сразу запустите его.','sudo systemctl enable --now nginx',['systemctl enable --now nginx'],'--now применяет enable не только к следующей загрузке, но и сейчас.',['systemctl','enable']],
  ['systemd-services','Medium','systemd','Журнал службы','Покажите последние 50 записей журнала nginx без pager.','journalctl -u nginx -n 50 --no-pager',['journalctl --no-pager -n 50 -u nginx'],'Фильтр unit и лимит строк дают компактную диагностическую выборку.',['journalctl','logs']],
  ['systemd-services','Medium','systemd','Ошибки этой загрузки','Покажите ошибки текущей загрузки с приоритетом err и выше.','journalctl -b -p err --no-pager',['journalctl -b -p 3 --no-pager'],'-b ограничивает текущей загрузкой, -p err — критичными уровнями.',['journalctl','boot']],
  ['systemd-services','Medium','systemd','Проверить автозапуск','Проверьте, включён ли nginx в автозапуск.','systemctl is-enabled nginx',[],'is-enabled возвращает состояние и полезный exit code для скриптов.',['systemctl','enable']],
  ['systemd-services','Medium','systemd','Перечитать unit-файлы','Перечитайте конфигурацию systemd после изменения unit-файла.','sudo systemctl daemon-reload',['systemctl daemon-reload'],'daemon-reload заново строит граф зависимостей unit-файлов.',['systemctl','units']],
  ['systemd-services','Medium','systemd','Провалившиеся службы','Покажите все systemd units в состоянии failed.','systemctl --failed',['systemctl list-units --state=failed'],'Список failed units — быстрый старт диагностики после сбоя.',['systemctl','debug']],
  ['systemd-services','Hard','systemd','Критический путь загрузки','Покажите критическую цепочку загрузки systemd.','systemd-analyze critical-chain',[],'critical-chain связывает время загрузки с последовательностью зависимостей.',['systemd-analyze','boot']],
  ['systemd-services','Hard','systemd','Переопределение лимита','Откройте drop-in override для nginx через systemctl.','sudo systemctl edit nginx',['systemctl edit nginx'],'systemctl edit создаёт drop-in и не изменяет пакетный unit напрямую.',['systemctl','override']],

  // Storage and filesystems — 10 (3 / 5 / 2)
  ['storage-filesystems','Easy','linux','Диск под контролем','Выведите занятое и доступное место всех смонтированных файловых систем с единицами.','df -h',['df -hP'],'df показывает свободное место на уровне файловой системы.',['df','disk']],
  ['storage-filesystems','Easy','linux','Блочные устройства','Покажите дерево дисков, разделов и точек монтирования.','lsblk',['lsblk -f'],'lsblk связывает блочные устройства с разделами и mountpoint.',['lsblk','disk']],
  ['storage-filesystems','Easy','linux','Тип файловой системы','Покажите тип файловой системы для /workspace.','df -T /workspace',['findmnt -T /workspace -o FSTYPE'],'df -T и findmnt определяют файловую систему, содержащую путь.',['filesystem','df']],
  ['storage-filesystems','Medium','linux','Кто съел место','Покажите размеры элементов первого уровня в /var, отсортированные по возрастанию.','du -xh --max-depth=1 /var | sort -h',['du -h -d 1 /var | sort -h'],'Ограничение глубины даёт обзор, sort -h понимает единицы размеров.',['du','disk']],
  ['storage-filesystems','Medium','linux','Inode закончились','Покажите использование inode на файловых системах.','df -i',[],'df -i выявляет нехватку inode даже при наличии свободных байтов.',['df','inode']],
  ['storage-filesystems','Medium','linux','Что смонтировано','Покажите источник, цель и тип файловой системы для /workspace.','findmnt -T /workspace',['findmnt --target /workspace'],'findmnt выбирает фактическое монтирование, обслуживающее путь.',['findmnt','mount']],
  ['storage-filesystems','Medium','linux','UUID разделов','Покажите UUID и типы файловых систем блочных устройств.','lsblk -f',['blkid'],'UUID стабильно идентифицирует файловую систему независимо от имени устройства.',['lsblk','uuid']],
  ['storage-filesystems','Medium','linux','Создать hard link','Создайте жёсткую ссылку /workspace/report.latest на /workspace/report.txt.','ln /workspace/report.txt /workspace/report.latest',[],'Hard link указывает на тот же inode и остаётся рабочим после переименования исходного имени.',['ln','inode'],{hint:'ln /workspace/report.txt /workspace/report.latest',setupScript:"mkdir -p /workspace; printf 'ready\\n' > /workspace/report.txt; rm -f /workspace/report.latest",checkScript:'[ /workspace/report.txt -ef /workspace/report.latest ]'}],
  ['storage-filesystems','Hard','linux','Удалён, но открыт','Найдите удалённые файлы, которые процессы продолжают держать открытыми.','lsof +L1',['lsof | grep deleted'],'+L1 выбирает открытые файлы с числом ссылок меньше единицы.',['lsof','disk']],
  ['storage-filesystems','Hard','linux','Только эта файловая система','Найдите 20 крупнейших обычных файлов в /var, не переходя на другие файловые системы.','find /var -xdev -type f -printf "%s %p\\n" | sort -nr | head -n 20',[],'find печатает числовой размер, а -xdev удерживает поиск на одном mount.',['find','disk']],

  // Bash and shell — 10 (3 / 5 / 2)
  ['bash-shell','Easy','bash','Успех второй команды','Запустите deploy.sh только если tests.sh завершился успешно.','./tests.sh && ./deploy.sh',[],'&& выполняет правую команду только при нулевом exit code левой.',['bash','control']],
  ['bash-shell','Easy','bash','Значение по умолчанию','Выведите PORT, а если переменная пуста или не задана — 8080.','echo "${PORT:-8080}"',['printf "%s\\n" "${PORT:-8080}"'],'Оператор :- подставляет fallback и для unset, и для пустого значения.',['bash','variables']],
  ['bash-shell','Easy','bash','Сохранить вывод','Запишите stdout команды date в /workspace/now.txt.','date > /workspace/now.txt',[],'Оператор > перенаправляет stdout и заменяет содержимое файла.',['bash','redirect'],{hint:'date > /workspace/now.txt',setupScript:'mkdir -p /workspace; rm -f /workspace/now.txt',checkScript:'[ -s /workspace/now.txt ]'}],
  ['bash-shell','Medium','bash','И stdout, и stderr','Запишите оба потока команды ./job.sh в /workspace/job.log.','./job.sh > /workspace/job.log 2>&1',['./job.sh &> /workspace/job.log'],'2>&1 направляет stderr туда, куда уже направлен stdout.',['bash','redirect']],
  ['bash-shell','Medium','bash','Bash без скрытых ошибок','Настройте текущий Bash так, чтобы он замечал сбой команды, unset-переменную и ошибку внутри конвейера.','set -euo pipefail',[],'Эти флаги делают скрытые ошибки скрипта явными.',['bash','safety']],
  ['bash-shell','Medium','bash','Цикл по файлам','Для каждого .log файла в /workspace/logs выведите его имя безопасно для пробелов.','for file in /workspace/logs/*.log; do printf "%s\\n" "$file"; done',[],'Кавычки вокруг переменной защищают пробелы и glob-символы в имени.',['bash','loops']],
  ['bash-shell','Medium','bash','Поймать завершение','Зарегистрируйте удаление /tmp/job.lock при выходе из shell-скрипта.','trap "rm -f /tmp/job.lock" EXIT',["trap 'rm -f /tmp/job.lock' EXIT"],'Trap EXIT выполняет уборку и при успехе, и при большинстве ошибок.',['bash','trap']],
  ['bash-shell','Medium','bash','Проверить код','Запустите command и затем выведите её exit code.','command; echo "$?"',['command; printf "%s\\n" "$?"'],'$? содержит статус последнего foreground pipeline.',['bash','exit-code']],
  ['bash-shell','Hard','bash','Безопасно прочитать строки','Прочитайте /workspace/items.txt построчно, не теряя обратные слеши и пробелы.','while IFS= read -r line; do printf "%s\\n" "$line"; done < /workspace/items.txt',[],'IFS= сохраняет края строки, read -r не интерпретирует backslash.',['bash','read']],
  ['bash-shell','Hard','bash','Ошибка внутри pipeline','Выполните grep ERROR /workspace/app.log | head и сделайте ошибку grep видимой для скрипта.','set -o pipefail; grep ERROR /workspace/app.log | head',[],'pipefail возвращает ошибку любого этапа, а не только последнего head.',['bash','pipeline']],

  // Git and containers — 5 (2 / 2 / 1)
  ['git-containers','Easy','git','Рабочее дерево','Покажите краткий статус Git-репозитория.','git status --short',['git status -s'],'Краткий формат удобен человеку и автоматизации.',['git','status']],
  ['git-containers','Easy','docker','Контейнеры в работе','Получите список только тех Docker-контейнеров, которые сейчас работают.','docker ps',['docker container ls'],'docker ps и container ls обращаются к одному API.',['docker','containers']],
  ['git-containers','Medium','git','Последние коммиты','Покажите последние 5 коммитов одной строкой каждый.','git log --oneline -5',['git log -5 --oneline'],'--oneline объединяет короткий hash и тему коммита.',['git','history']],
  ['git-containers','Medium','docker','Логи контейнера','Покажите последние 100 строк логов контейнера api.','docker logs --tail 100 api',['docker container logs --tail 100 api'],'--tail ограничивает объём при диагностике шумного сервиса.',['docker','logs']],
  ['git-containers','Hard','git','Вернуть один файл','Восстановите /workspace/app.conf из HEAD, не затрагивая остальные изменения.','git restore --source=HEAD -- /workspace/app.conf',['git checkout HEAD -- /workspace/app.conf'],'Явный pathspec ограничивает восстановление одним файлом.',['git','restore']],
];

function buildTask(spec: Spec, index: number): InterviewTask {
  const [topic, difficulty, category, title, description, solution, alternatives, explanation, tags, sandbox] = spec;
  const safeShellSolution = solution.replace(/'/g, `'\\''`);
  return {
    slug: `interview-${String(index + 1).padStart(3, '0')}`,
    title, description, topic, category, difficulty,
    type: sandbox ? 'real_shell' : 'quick',
    solution,
    alternatives: alternatives.length > 0 ? alternatives : [`bash -c '${safeShellSolution}'`],
    explanation, tags,
    ...(sandbox ? { sandbox } : {}),
  };
}

export const INTERVIEW_100: readonly InterviewTask[] = specs.map(buildTask);

export const INTERVIEW_TOPIC_LABELS: Readonly<Record<InterviewTopic, string>> = {
  'linux-fundamentals': 'Основы Linux',
  'files-text': 'Файлы и текст',
  'processes-performance': 'Процессы и производительность',
  networking: 'Сети',
  'permissions-security': 'Права и безопасность',
  'systemd-services': 'systemd и сервисы',
  'storage-filesystems': 'Диски и файловые системы',
  'bash-shell': 'Bash и shell',
  'git-containers': 'Git и контейнеры',
};

export function assertInterviewData(): void {
  if (INTERVIEW_100.length !== 100) throw new Error(`Interview 100 contains ${INTERVIEW_100.length} tasks`);
  if (new Set(INTERVIEW_100.map((task) => task.slug)).size !== 100) throw new Error('Interview slugs are not unique');
  const expectedDifficulty = { Easy: 30, Medium: 50, Hard: 20 };
  for (const [difficulty, expected] of Object.entries(expectedDifficulty)) {
    const actual = INTERVIEW_100.filter((task) => task.difficulty === difficulty).length;
    if (actual !== expected) throw new Error(`Interview ${difficulty}: expected ${expected}, got ${actual}`);
  }
  for (const task of INTERVIEW_100) {
    if (!task.title || !task.description || !task.solution || !task.explanation || task.tags.length === 0 || task.alternatives.length === 0) {
      throw new Error(`Interview task ${task.slug} is incomplete`);
    }
    if (task.type === 'real_shell' && !task.sandbox?.checkScript) throw new Error(`${task.slug} has no state validator`);
  }
}
