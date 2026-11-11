// supabase-config.js - Supabase Client Configuration
// ==============================================================================
// Obage Supabase Project credentials methana danna (Add your credentials here)
// Dashboard -> Project Settings -> API eken URL eka saha anon key eka labaa ganna.
// ==============================================================================

const DEFAULT_SUPABASE_URL = "https://ffgrxztjshhfabjtxlws.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZmZ3J4enRqc2hoZmFianR4bHdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyMzcyNTMsImV4cCI6MjEwOTgxMzI1M30.Psxm-56Ytgw7ePTfBylwGLYXkCLLBPg1XrIZBVXdrzQ";

function normalizeSupabaseUrl(url) {
    if (!url) return DEFAULT_SUPABASE_URL;
    return url.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
}

// Allow override from localStorage if set dynamically, otherwise use defaults above
const SUPABASE_URL = normalizeSupabaseUrl(localStorage.getItem('supabase_url') || DEFAULT_SUPABASE_URL);
const SUPABASE_ANON_KEY = (localStorage.getItem('supabase_anon_key') || DEFAULT_SUPABASE_ANON_KEY).trim();

window.SUPABASE_URL = SUPABASE_URL;
window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;

function isSupabaseConfigured() {
    return (
        window.SUPABASE_URL &&
        window.SUPABASE_ANON_KEY &&
        window.SUPABASE_URL !== "https://your-project-id.supabase.co" &&
        window.SUPABASE_ANON_KEY !== "your-anon-public-key"
    );
}

function initSupabaseClient() {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
        try {
            window.supabaseClient = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
                auth: {
                    persistSession: false,
                    autoRefreshToken: false
                }
            });
            console.log("Supabase client initialized successfully!");
        } catch (e) {
            console.error("Error creating Supabase client:", e);
        }
    } else {
        console.warn("Supabase library not yet loaded on window.");
    }
}

// Automatically initialize if library is already present
initSupabaseClient();

window.isSupabaseConfigured = isSupabaseConfigured;
window.initSupabaseClient = initSupabaseClient;
