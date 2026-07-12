import { getPrefs } from './prefs.js';

// Core-UI translations. Keys map to the always-visible chrome (nav, tabs,
// settings, dashboard headings, common actions). Anything not translated for a
// language falls back to English. UI text switches when the Language setting
// changes; deeper screens (task modal, chat body, etc.) stay in English.
const STR = {
  en: {
    'nav.home': 'Home', 'nav.dms': 'DMs', 'nav.people': 'People', 'nav.activity': 'Activity',
    'nav.files': 'Files', 'nav.tasks': 'Tasks', 'nav.workflows': 'Workflows', 'nav.admin': 'Admin',
    'sidebar.channels': 'Channels', 'action.search': 'Search messages', 'action.settings': 'Settings', 'action.signout': 'Sign out',
    'files.shared': 'Shared files', 'files.drive': 'Drive', 'people.team': 'Team', 'people.collabs': 'Collabs',
    'settings.title': 'Settings', 'settings.profile': 'Profile', 'settings.appearance': 'Appearance', 'settings.notifications': 'Notifications',
    'settings.messages': 'Messages & media', 'settings.language': 'Language & region', 'settings.accessibility': 'Accessibility',
    'settings.advanced': 'Advanced', 'settings.account': 'Account & password',
    'dash.opentasks': 'Open tasks', 'dash.upcoming': 'Upcoming deadlines', 'dash.taskboard': 'Task board', 'dash.workload': 'Team workload',
    'dash.activity': 'Recent activity', 'dash.allopen': 'All open tasks', 'dash.urgent': 'Urgent tasks', 'dash.seeall': 'See all activity',
  },
  hi: {
    'nav.home': 'होम', 'nav.dms': 'डीएम', 'nav.people': 'लोग', 'nav.activity': 'गतिविधि', 'nav.files': 'फ़ाइलें', 'nav.tasks': 'कार्य', 'nav.workflows': 'वर्कफ़्लो', 'nav.admin': 'एडमिन',
    'sidebar.channels': 'चैनल', 'action.search': 'संदेश खोजें', 'action.settings': 'सेटिंग्स', 'action.signout': 'साइन आउट',
    'files.shared': 'साझा फ़ाइलें', 'files.drive': 'ड्राइव', 'people.team': 'टीम', 'people.collabs': 'कोलैब',
    'settings.title': 'सेटिंग्स', 'settings.profile': 'प्रोफ़ाइल', 'settings.appearance': 'रूप', 'settings.notifications': 'सूचनाएँ',
    'settings.messages': 'संदेश और मीडिया', 'settings.language': 'भाषा और क्षेत्र', 'settings.accessibility': 'पहुँच-योग्यता', 'settings.advanced': 'उन्नत', 'settings.account': 'खाता और पासवर्ड',
    'dash.opentasks': 'कार्य खोलें', 'dash.upcoming': 'आगामी समय-सीमाएँ', 'dash.taskboard': 'कार्य बोर्ड', 'dash.workload': 'टीम कार्यभार',
    'dash.activity': 'हाल की गतिविधि', 'dash.allopen': 'सभी खुले कार्य', 'dash.urgent': 'अत्यावश्यक कार्य', 'dash.seeall': 'सभी गतिविधि देखें',
  },
  bn: {
    'nav.home': 'হোম', 'nav.dms': 'ডিএম', 'nav.people': 'লোকজন', 'nav.activity': 'কার্যকলাপ', 'nav.files': 'ফাইল', 'nav.tasks': 'কাজ', 'nav.workflows': 'ওয়ার্কফ্লো', 'nav.admin': 'অ্যাডমিন',
    'sidebar.channels': 'চ্যানেল', 'action.search': 'বার্তা খুঁজুন', 'action.settings': 'সেটিংস', 'action.signout': 'সাইন আউট',
    'files.shared': 'শেয়ার করা ফাইল', 'files.drive': 'ড্রাইভ', 'people.team': 'টিম', 'people.collabs': 'কোল্যাব',
    'settings.title': 'সেটিংস', 'settings.profile': 'প্রোফাইল', 'settings.appearance': 'চেহারা', 'settings.notifications': 'বিজ্ঞপ্তি',
    'settings.messages': 'বার্তা ও মিডিয়া', 'settings.language': 'ভাষা ও অঞ্চল', 'settings.accessibility': 'অ্যাক্সেসিবিলিটি', 'settings.advanced': 'উন্নত', 'settings.account': 'অ্যাকাউন্ট ও পাসওয়ার্ড',
    'dash.opentasks': 'কাজ খুলুন', 'dash.upcoming': 'আসন্ন সময়সীমা', 'dash.taskboard': 'টাস্ক বোর্ড', 'dash.workload': 'টিমের কাজের চাপ',
    'dash.activity': 'সাম্প্রতিক কার্যকলাপ', 'dash.allopen': 'সব খোলা কাজ', 'dash.urgent': 'জরুরি কাজ', 'dash.seeall': 'সব কার্যকলাপ দেখুন',
  },
  ta: {
    'nav.home': 'முகப்பு', 'nav.dms': 'நேரடி செய்திகள்', 'nav.people': 'நபர்கள்', 'nav.activity': 'செயல்பாடு', 'nav.files': 'கோப்புகள்', 'nav.tasks': 'பணிகள்', 'nav.workflows': 'பணிப்பாய்வுகள்', 'nav.admin': 'நிர்வாகம்',
    'sidebar.channels': 'சேனல்கள்', 'action.search': 'செய்திகளைத் தேடு', 'action.settings': 'அமைப்புகள்', 'action.signout': 'வெளியேறு',
    'files.shared': 'பகிர்ந்த கோப்புகள்', 'files.drive': 'டிரைவ்', 'people.team': 'குழு', 'people.collabs': 'கூட்டுப்பணி',
    'settings.title': 'அமைப்புகள்', 'settings.profile': 'சுயவிவரம்', 'settings.appearance': 'தோற்றம்', 'settings.notifications': 'அறிவிப்புகள்',
    'settings.messages': 'செய்திகள் & மீடியா', 'settings.language': 'மொழி & பகுதி', 'settings.accessibility': 'அணுகல்தன்மை', 'settings.advanced': 'மேம்பட்ட', 'settings.account': 'கணக்கு & கடவுச்சொல்',
    'dash.opentasks': 'பணிகளைத் திற', 'dash.upcoming': 'வரவிருக்கும் காலக்கெடுக்கள்', 'dash.taskboard': 'பணி பலகை', 'dash.workload': 'குழு பணிச்சுமை',
    'dash.activity': 'சமீபத்திய செயல்பாடு', 'dash.allopen': 'அனைத்து திறந்த பணிகள்', 'dash.urgent': 'அவசர பணிகள்', 'dash.seeall': 'அனைத்து செயல்பாடுகளையும் காண்க',
  },
  es: {
    'nav.home': 'Inicio', 'nav.dms': 'MD', 'nav.people': 'Personas', 'nav.activity': 'Actividad', 'nav.files': 'Archivos', 'nav.tasks': 'Tareas', 'nav.workflows': 'Flujos', 'nav.admin': 'Admin',
    'sidebar.channels': 'Canales', 'action.search': 'Buscar mensajes', 'action.settings': 'Ajustes', 'action.signout': 'Cerrar sesión',
    'files.shared': 'Archivos compartidos', 'files.drive': 'Drive', 'people.team': 'Equipo', 'people.collabs': 'Colaboraciones',
    'settings.title': 'Ajustes', 'settings.profile': 'Perfil', 'settings.appearance': 'Apariencia', 'settings.notifications': 'Notificaciones',
    'settings.messages': 'Mensajes y multimedia', 'settings.language': 'Idioma y región', 'settings.accessibility': 'Accesibilidad', 'settings.advanced': 'Avanzado', 'settings.account': 'Cuenta y contraseña',
    'dash.opentasks': 'Abrir tareas', 'dash.upcoming': 'Próximos vencimientos', 'dash.taskboard': 'Tablero de tareas', 'dash.workload': 'Carga del equipo',
    'dash.activity': 'Actividad reciente', 'dash.allopen': 'Todas las tareas abiertas', 'dash.urgent': 'Tareas urgentes', 'dash.seeall': 'Ver toda la actividad',
  },
  fr: {
    'nav.home': 'Accueil', 'nav.dms': 'MP', 'nav.people': 'Personnes', 'nav.activity': 'Activité', 'nav.files': 'Fichiers', 'nav.tasks': 'Tâches', 'nav.workflows': 'Flux', 'nav.admin': 'Admin',
    'sidebar.channels': 'Canaux', 'action.search': 'Rechercher des messages', 'action.settings': 'Paramètres', 'action.signout': 'Se déconnecter',
    'files.shared': 'Fichiers partagés', 'files.drive': 'Drive', 'people.team': 'Équipe', 'people.collabs': 'Collabs',
    'settings.title': 'Paramètres', 'settings.profile': 'Profil', 'settings.appearance': 'Apparence', 'settings.notifications': 'Notifications',
    'settings.messages': 'Messages et médias', 'settings.language': 'Langue et région', 'settings.accessibility': 'Accessibilité', 'settings.advanced': 'Avancé', 'settings.account': 'Compte et mot de passe',
    'dash.opentasks': 'Ouvrir les tâches', 'dash.upcoming': 'Échéances à venir', 'dash.taskboard': 'Tableau des tâches', 'dash.workload': "Charge de l'équipe",
    'dash.activity': 'Activité récente', 'dash.allopen': 'Toutes les tâches ouvertes', 'dash.urgent': 'Tâches urgentes', 'dash.seeall': "Voir toute l'activité",
  },
  de: {
    'nav.home': 'Start', 'nav.dms': 'DMs', 'nav.people': 'Personen', 'nav.activity': 'Aktivität', 'nav.files': 'Dateien', 'nav.tasks': 'Aufgaben', 'nav.workflows': 'Workflows', 'nav.admin': 'Admin',
    'sidebar.channels': 'Kanäle', 'action.search': 'Nachrichten suchen', 'action.settings': 'Einstellungen', 'action.signout': 'Abmelden',
    'files.shared': 'Geteilte Dateien', 'files.drive': 'Drive', 'people.team': 'Team', 'people.collabs': 'Collabs',
    'settings.title': 'Einstellungen', 'settings.profile': 'Profil', 'settings.appearance': 'Darstellung', 'settings.notifications': 'Benachrichtigungen',
    'settings.messages': 'Nachrichten & Medien', 'settings.language': 'Sprache & Region', 'settings.accessibility': 'Barrierefreiheit', 'settings.advanced': 'Erweitert', 'settings.account': 'Konto & Passwort',
    'dash.opentasks': 'Aufgaben öffnen', 'dash.upcoming': 'Anstehende Fristen', 'dash.taskboard': 'Aufgabenboard', 'dash.workload': 'Team-Auslastung',
    'dash.activity': 'Letzte Aktivität', 'dash.allopen': 'Alle offenen Aufgaben', 'dash.urgent': 'Dringende Aufgaben', 'dash.seeall': 'Gesamte Aktivität anzeigen',
  },
  pt: {
    'nav.home': 'Início', 'nav.dms': 'MDs', 'nav.people': 'Pessoas', 'nav.activity': 'Atividade', 'nav.files': 'Arquivos', 'nav.tasks': 'Tarefas', 'nav.workflows': 'Fluxos', 'nav.admin': 'Admin',
    'sidebar.channels': 'Canais', 'action.search': 'Buscar mensagens', 'action.settings': 'Configurações', 'action.signout': 'Sair',
    'files.shared': 'Arquivos compartilhados', 'files.drive': 'Drive', 'people.team': 'Equipe', 'people.collabs': 'Colabs',
    'settings.title': 'Configurações', 'settings.profile': 'Perfil', 'settings.appearance': 'Aparência', 'settings.notifications': 'Notificações',
    'settings.messages': 'Mensagens e mídia', 'settings.language': 'Idioma e região', 'settings.accessibility': 'Acessibilidade', 'settings.advanced': 'Avançado', 'settings.account': 'Conta e senha',
    'dash.opentasks': 'Abrir tarefas', 'dash.upcoming': 'Prazos futuros', 'dash.taskboard': 'Quadro de tarefas', 'dash.workload': 'Carga da equipe',
    'dash.activity': 'Atividade recente', 'dash.allopen': 'Todas as tarefas abertas', 'dash.urgent': 'Tarefas urgentes', 'dash.seeall': 'Ver toda a atividade',
  },
  it: {
    'nav.home': 'Home', 'nav.dms': 'MD', 'nav.people': 'Persone', 'nav.activity': 'Attività', 'nav.files': 'File', 'nav.tasks': 'Attività', 'nav.workflows': 'Flussi', 'nav.admin': 'Admin',
    'sidebar.channels': 'Canali', 'action.search': 'Cerca messaggi', 'action.settings': 'Impostazioni', 'action.signout': 'Esci',
    'files.shared': 'File condivisi', 'files.drive': 'Drive', 'people.team': 'Team', 'people.collabs': 'Collab',
    'settings.title': 'Impostazioni', 'settings.profile': 'Profilo', 'settings.appearance': 'Aspetto', 'settings.notifications': 'Notifiche',
    'settings.messages': 'Messaggi e media', 'settings.language': 'Lingua e regione', 'settings.accessibility': 'Accessibilità', 'settings.advanced': 'Avanzate', 'settings.account': 'Account e password',
    'dash.opentasks': 'Apri attività', 'dash.upcoming': 'Scadenze imminenti', 'dash.taskboard': 'Bacheca attività', 'dash.workload': 'Carico del team',
    'dash.activity': 'Attività recente', 'dash.allopen': 'Tutte le attività aperte', 'dash.urgent': 'Attività urgenti', 'dash.seeall': 'Vedi tutta l’attività',
  },
  nl: {
    'nav.home': 'Home', 'nav.dms': 'DM’s', 'nav.people': 'Mensen', 'nav.activity': 'Activiteit', 'nav.files': 'Bestanden', 'nav.tasks': 'Taken', 'nav.workflows': 'Workflows', 'nav.admin': 'Beheer',
    'sidebar.channels': 'Kanalen', 'action.search': 'Berichten zoeken', 'action.settings': 'Instellingen', 'action.signout': 'Afmelden',
    'files.shared': 'Gedeelde bestanden', 'files.drive': 'Drive', 'people.team': 'Team', 'people.collabs': 'Collabs',
    'settings.title': 'Instellingen', 'settings.profile': 'Profiel', 'settings.appearance': 'Weergave', 'settings.notifications': 'Meldingen',
    'settings.messages': 'Berichten & media', 'settings.language': 'Taal & regio', 'settings.accessibility': 'Toegankelijkheid', 'settings.advanced': 'Geavanceerd', 'settings.account': 'Account & wachtwoord',
    'dash.opentasks': 'Taken openen', 'dash.upcoming': 'Aankomende deadlines', 'dash.taskboard': 'Takenbord', 'dash.workload': 'Teamwerklast',
    'dash.activity': 'Recente activiteit', 'dash.allopen': 'Alle open taken', 'dash.urgent': 'Urgente taken', 'dash.seeall': 'Alle activiteit bekijken',
  },
  ru: {
    'nav.home': 'Главная', 'nav.dms': 'ЛС', 'nav.people': 'Люди', 'nav.activity': 'Активность', 'nav.files': 'Файлы', 'nav.tasks': 'Задачи', 'nav.workflows': 'Процессы', 'nav.admin': 'Админ',
    'sidebar.channels': 'Каналы', 'action.search': 'Поиск сообщений', 'action.settings': 'Настройки', 'action.signout': 'Выйти',
    'files.shared': 'Общие файлы', 'files.drive': 'Диск', 'people.team': 'Команда', 'people.collabs': 'Коллабы',
    'settings.title': 'Настройки', 'settings.profile': 'Профиль', 'settings.appearance': 'Оформление', 'settings.notifications': 'Уведомления',
    'settings.messages': 'Сообщения и медиа', 'settings.language': 'Язык и регион', 'settings.accessibility': 'Доступность', 'settings.advanced': 'Дополнительно', 'settings.account': 'Аккаунт и пароль',
    'dash.opentasks': 'Открыть задачи', 'dash.upcoming': 'Ближайшие сроки', 'dash.taskboard': 'Доска задач', 'dash.workload': 'Нагрузка команды',
    'dash.activity': 'Недавняя активность', 'dash.allopen': 'Все открытые задачи', 'dash.urgent': 'Срочные задачи', 'dash.seeall': 'Вся активность',
  },
  tr: {
    'nav.home': 'Ana sayfa', 'nav.dms': 'DM', 'nav.people': 'Kişiler', 'nav.activity': 'Etkinlik', 'nav.files': 'Dosyalar', 'nav.tasks': 'Görevler', 'nav.workflows': 'İş akışları', 'nav.admin': 'Yönetici',
    'sidebar.channels': 'Kanallar', 'action.search': 'Mesajlarda ara', 'action.settings': 'Ayarlar', 'action.signout': 'Çıkış yap',
    'files.shared': 'Paylaşılan dosyalar', 'files.drive': 'Drive', 'people.team': 'Ekip', 'people.collabs': 'Collab',
    'settings.title': 'Ayarlar', 'settings.profile': 'Profil', 'settings.appearance': 'Görünüm', 'settings.notifications': 'Bildirimler',
    'settings.messages': 'Mesajlar ve medya', 'settings.language': 'Dil ve bölge', 'settings.accessibility': 'Erişilebilirlik', 'settings.advanced': 'Gelişmiş', 'settings.account': 'Hesap ve şifre',
    'dash.opentasks': 'Görevleri aç', 'dash.upcoming': 'Yaklaşan son tarihler', 'dash.taskboard': 'Görev panosu', 'dash.workload': 'Ekip iş yükü',
    'dash.activity': 'Son etkinlik', 'dash.allopen': 'Tüm açık görevler', 'dash.urgent': 'Acil görevler', 'dash.seeall': 'Tüm etkinliği gör',
  },
  pl: {
    'nav.home': 'Start', 'nav.dms': 'PW', 'nav.people': 'Osoby', 'nav.activity': 'Aktywność', 'nav.files': 'Pliki', 'nav.tasks': 'Zadania', 'nav.workflows': 'Procesy', 'nav.admin': 'Admin',
    'sidebar.channels': 'Kanały', 'action.search': 'Szukaj wiadomości', 'action.settings': 'Ustawienia', 'action.signout': 'Wyloguj',
    'files.shared': 'Udostępnione pliki', 'files.drive': 'Dysk', 'people.team': 'Zespół', 'people.collabs': 'Współprace',
    'settings.title': 'Ustawienia', 'settings.profile': 'Profil', 'settings.appearance': 'Wygląd', 'settings.notifications': 'Powiadomienia',
    'settings.messages': 'Wiadomości i multimedia', 'settings.language': 'Język i region', 'settings.accessibility': 'Dostępność', 'settings.advanced': 'Zaawansowane', 'settings.account': 'Konto i hasło',
    'dash.opentasks': 'Otwórz zadania', 'dash.upcoming': 'Nadchodzące terminy', 'dash.taskboard': 'Tablica zadań', 'dash.workload': 'Obciążenie zespołu',
    'dash.activity': 'Ostatnia aktywność', 'dash.allopen': 'Wszystkie otwarte zadania', 'dash.urgent': 'Pilne zadania', 'dash.seeall': 'Zobacz całą aktywność',
  },
  ar: {
    'nav.home': 'الرئيسية', 'nav.dms': 'الرسائل', 'nav.people': 'الأشخاص', 'nav.activity': 'النشاط', 'nav.files': 'الملفات', 'nav.tasks': 'المهام', 'nav.workflows': 'مسارات العمل', 'nav.admin': 'المشرف',
    'sidebar.channels': 'القنوات', 'action.search': 'بحث في الرسائل', 'action.settings': 'الإعدادات', 'action.signout': 'تسجيل الخروج',
    'files.shared': 'الملفات المشتركة', 'files.drive': 'الأقراص', 'people.team': 'الفريق', 'people.collabs': 'التعاونات',
    'settings.title': 'الإعدادات', 'settings.profile': 'الملف الشخصي', 'settings.appearance': 'المظهر', 'settings.notifications': 'الإشعارات',
    'settings.messages': 'الرسائل والوسائط', 'settings.language': 'اللغة والمنطقة', 'settings.accessibility': 'إمكانية الوصول', 'settings.advanced': 'متقدم', 'settings.account': 'الحساب وكلمة المرور',
    'dash.opentasks': 'فتح المهام', 'dash.upcoming': 'المواعيد القادمة', 'dash.taskboard': 'لوحة المهام', 'dash.workload': 'عبء عمل الفريق',
    'dash.activity': 'النشاط الأخير', 'dash.allopen': 'كل المهام المفتوحة', 'dash.urgent': 'المهام العاجلة', 'dash.seeall': 'عرض كل النشاط',
  },
  zh: {
    'nav.home': '主页', 'nav.dms': '私信', 'nav.people': '成员', 'nav.activity': '动态', 'nav.files': '文件', 'nav.tasks': '任务', 'nav.workflows': '工作流', 'nav.admin': '管理',
    'sidebar.channels': '频道', 'action.search': '搜索消息', 'action.settings': '设置', 'action.signout': '退出登录',
    'files.shared': '共享文件', 'files.drive': '云盘', 'people.team': '团队', 'people.collabs': '协作',
    'settings.title': '设置', 'settings.profile': '个人资料', 'settings.appearance': '外观', 'settings.notifications': '通知',
    'settings.messages': '消息与媒体', 'settings.language': '语言与地区', 'settings.accessibility': '无障碍', 'settings.advanced': '高级', 'settings.account': '账户与密码',
    'dash.opentasks': '打开任务', 'dash.upcoming': '即将到期', 'dash.taskboard': '任务看板', 'dash.workload': '团队工作量',
    'dash.activity': '最近动态', 'dash.allopen': '所有未完成任务', 'dash.urgent': '紧急任务', 'dash.seeall': '查看全部动态',
  },
  ja: {
    'nav.home': 'ホーム', 'nav.dms': 'DM', 'nav.people': 'メンバー', 'nav.activity': 'アクティビティ', 'nav.files': 'ファイル', 'nav.tasks': 'タスク', 'nav.workflows': 'ワークフロー', 'nav.admin': '管理',
    'sidebar.channels': 'チャンネル', 'action.search': 'メッセージを検索', 'action.settings': '設定', 'action.signout': 'サインアウト',
    'files.shared': '共有ファイル', 'files.drive': 'ドライブ', 'people.team': 'チーム', 'people.collabs': 'コラボ',
    'settings.title': '設定', 'settings.profile': 'プロフィール', 'settings.appearance': '外観', 'settings.notifications': '通知',
    'settings.messages': 'メッセージとメディア', 'settings.language': '言語と地域', 'settings.accessibility': 'アクセシビリティ', 'settings.advanced': '詳細', 'settings.account': 'アカウントとパスワード',
    'dash.opentasks': 'タスクを開く', 'dash.upcoming': '今後の締め切り', 'dash.taskboard': 'タスクボード', 'dash.workload': 'チームの負荷',
    'dash.activity': '最近のアクティビティ', 'dash.allopen': 'すべての未完了タスク', 'dash.urgent': '緊急のタスク', 'dash.seeall': 'すべてのアクティビティを見る',
  },
  ko: {
    'nav.home': '홈', 'nav.dms': 'DM', 'nav.people': '사람', 'nav.activity': '활동', 'nav.files': '파일', 'nav.tasks': '작업', 'nav.workflows': '워크플로', 'nav.admin': '관리자',
    'sidebar.channels': '채널', 'action.search': '메시지 검색', 'action.settings': '설정', 'action.signout': '로그아웃',
    'files.shared': '공유 파일', 'files.drive': '드라이브', 'people.team': '팀', 'people.collabs': '협업',
    'settings.title': '설정', 'settings.profile': '프로필', 'settings.appearance': '모양', 'settings.notifications': '알림',
    'settings.messages': '메시지 및 미디어', 'settings.language': '언어 및 지역', 'settings.accessibility': '접근성', 'settings.advanced': '고급', 'settings.account': '계정 및 비밀번호',
    'dash.opentasks': '작업 열기', 'dash.upcoming': '다가오는 마감일', 'dash.taskboard': '작업 보드', 'dash.workload': '팀 업무량',
    'dash.activity': '최근 활동', 'dash.allopen': '모든 열린 작업', 'dash.urgent': '긴급 작업', 'dash.seeall': '모든 활동 보기',
  },
  id: {
    'nav.home': 'Beranda', 'nav.dms': 'DM', 'nav.people': 'Orang', 'nav.activity': 'Aktivitas', 'nav.files': 'Berkas', 'nav.tasks': 'Tugas', 'nav.workflows': 'Alur kerja', 'nav.admin': 'Admin',
    'sidebar.channels': 'Kanal', 'action.search': 'Cari pesan', 'action.settings': 'Pengaturan', 'action.signout': 'Keluar',
    'files.shared': 'Berkas dibagikan', 'files.drive': 'Drive', 'people.team': 'Tim', 'people.collabs': 'Kolaborasi',
    'settings.title': 'Pengaturan', 'settings.profile': 'Profil', 'settings.appearance': 'Tampilan', 'settings.notifications': 'Notifikasi',
    'settings.messages': 'Pesan & media', 'settings.language': 'Bahasa & wilayah', 'settings.accessibility': 'Aksesibilitas', 'settings.advanced': 'Lanjutan', 'settings.account': 'Akun & kata sandi',
    'dash.opentasks': 'Buka tugas', 'dash.upcoming': 'Tenggat mendatang', 'dash.taskboard': 'Papan tugas', 'dash.workload': 'Beban kerja tim',
    'dash.activity': 'Aktivitas terbaru', 'dash.allopen': 'Semua tugas terbuka', 'dash.urgent': 'Tugas mendesak', 'dash.seeall': 'Lihat semua aktivitas',
  },
  vi: {
    'nav.home': 'Trang chủ', 'nav.dms': 'Tin nhắn', 'nav.people': 'Mọi người', 'nav.activity': 'Hoạt động', 'nav.files': 'Tệp', 'nav.tasks': 'Công việc', 'nav.workflows': 'Quy trình', 'nav.admin': 'Quản trị',
    'sidebar.channels': 'Kênh', 'action.search': 'Tìm tin nhắn', 'action.settings': 'Cài đặt', 'action.signout': 'Đăng xuất',
    'files.shared': 'Tệp đã chia sẻ', 'files.drive': 'Drive', 'people.team': 'Nhóm', 'people.collabs': 'Cộng tác',
    'settings.title': 'Cài đặt', 'settings.profile': 'Hồ sơ', 'settings.appearance': 'Giao diện', 'settings.notifications': 'Thông báo',
    'settings.messages': 'Tin nhắn & phương tiện', 'settings.language': 'Ngôn ngữ & khu vực', 'settings.accessibility': 'Trợ năng', 'settings.advanced': 'Nâng cao', 'settings.account': 'Tài khoản & mật khẩu',
    'dash.opentasks': 'Mở công việc', 'dash.upcoming': 'Hạn sắp tới', 'dash.taskboard': 'Bảng công việc', 'dash.workload': 'Khối lượng của nhóm',
    'dash.activity': 'Hoạt động gần đây', 'dash.allopen': 'Tất cả công việc đang mở', 'dash.urgent': 'Công việc khẩn', 'dash.seeall': 'Xem tất cả hoạt động',
  },
};

// Which base language to use, derived from the Language preference (or device).
export function currentLang() {
  let l = getPrefs().locale;
  if (!l || l === 'auto') { try { l = navigator.language || 'en'; } catch { l = 'en'; } }
  return String(l).split('-')[0].toLowerCase();
}

export function t(key) {
  const lang = currentLang();
  return (STR[lang] && STR[lang][key]) || STR.en[key] || key;
}

// Notify subscribers (the app root) to re-render when the language changes.
let listeners = [];
export function onLangChange(cb) { listeners.push(cb); return () => { listeners = listeners.filter((x) => x !== cb); }; }
export function notifyLangChange() { listeners.forEach((cb) => cb()); }
