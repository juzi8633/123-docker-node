/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: { 
        surface: '#ffffff',
        background: '#f8fafc',
        primary: { DEFAULT: '#4f46e5', light: '#818cf8', dark: '#3730a3' },
        success: '#10b981',
        warning: '#f59e0b'
      },
      boxShadow: {
        'soft': '0 4px 20px -2px rgba(0, 0, 0, 0.05)',
        'glow': '0 0 15px rgba(79, 70, 229, 0.3)'
      }
    },
  },
  plugins: [],
}