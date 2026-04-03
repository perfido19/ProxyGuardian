#!/usr/bin/env python3
# =============================================================
# asn-log-stats.py
# Analizza log (nginx o kern) e conta richieste/pacchetti per ASN
# Uso:
#   python3 /usr/local/bin/asn-log-stats.py
#   python3 /usr/local/bin/asn-log-stats.py --source nginx
#   python3 /usr/local/bin/asn-log-stats.py --top 20
#   python3 /usr/local/bin/asn-log-stats.py --since "2024-01-01"
#   python3 /usr/local/bin/asn-log-stats.py --json
# =============================================================

import sys
import re
import json
import argparse
import maxminddb
from collections import defaultdict
from datetime import datetime

MMDB = "/usr/share/GeoIP/GeoLite2-ASN.mmdb"
COUNTRY_MMDB = "/usr/share/GeoIP/GeoLite2-Country.mmdb"
ASN_FILE = "/etc/asn-blocklist.txt"
KERN_LOG = "/var/log/kern.log"
NGINX_LOG = "/var/log/nginx/access.log"

# ISO Alpha-2 → English country name mapping
ISO2_NAMES = {
    "AF": "Afghanistan",
    "AX": "Aland Islands",
    "AL": "Albania",
    "DZ": "Algeria",
    "AS": "American Samoa",
    "AD": "Andorra",
    "AO": "Angola",
    "AI": "Anguilla",
    "AQ": "Antarctica",
    "AG": "Antigua and Barbuda",
    "AR": "Argentina",
    "AM": "Armenia",
    "AW": "Aruba",
    "AU": "Australia",
    "AT": "Austria",
    "AZ": "Azerbaijan",
    "BS": "Bahamas",
    "BH": "Bahrain",
    "BD": "Bangladesh",
    "BB": "Barbados",
    "BY": "Belarus",
    "BE": "Belgium",
    "BZ": "Belize",
    "BJ": "Benin",
    "BM": "Bermuda",
    "BT": "Bhutan",
    "BO": "Bolivia",
    "BQ": "Bonaire",
    "BA": "Bosnia and Herzegovina",
    "BW": "Botswana",
    "BV": "Bouvet Island",
    "BR": "Brazil",
    "IO": "British Indian Ocean Territory",
    "BN": "Brunei Darussalam",
    "BG": "Bulgaria",
    "BF": "Burkina Faso",
    "BI": "Burundi",
    "CV": "Cabo Verde",
    "KH": "Cambodia",
    "CM": "Cameroon",
    "CA": "Canada",
    "KY": "Cayman Islands",
    "CF": "Central African Republic",
    "TD": "Chad",
    "CL": "Chile",
    "CN": "China",
    "CX": "Christmas Island",
    "CC": "Cocos Islands",
    "CO": "Colombia",
    "KM": "Comoros",
    "CG": "Congo",
    "CD": "Congo (Democratic Republic)",
    "CK": "Cook Islands",
    "CR": "Costa Rica",
    "CI": "Cote d'Ivoire",
    "HR": "Croatia",
    "CU": "Cuba",
    "CW": "Curacao",
    "CY": "Cyprus",
    "CZ": "Czechia",
    "DK": "Denmark",
    "DJ": "Djibouti",
    "DM": "Dominica",
    "DO": "Dominican Republic",
    "EC": "Ecuador",
    "EG": "Egypt",
    "SV": "El Salvador",
    "GQ": "Equatorial Guinea",
    "ER": "Eritrea",
    "EE": "Estonia",
    "SZ": "Eswatini",
    "ET": "Ethiopia",
    "FK": "Falkland Islands",
    "FO": "Faroe Islands",
    "FJ": "Fiji",
    "FI": "Finland",
    "FR": "France",
    "GF": "French Guiana",
    "PF": "French Polynesia",
    "TF": "French Southern Territories",
    "GA": "Gabon",
    "GM": "Gambia",
    "GE": "Georgia",
    "DE": "Germany",
    "GH": "Ghana",
    "GI": "Gibraltar",
    "GR": "Greece",
    "GL": "Greenland",
    "GD": "Grenada",
    "GP": "Guadeloupe",
    "GU": "Guam",
    "GT": "Guatemala",
    "GG": "Guernsey",
    "GN": "Guinea",
    "GW": "Guinea-Bissau",
    "GY": "Guyana",
    "HT": "Haiti",
    "HM": "Heard Island and McDonald Islands",
    "VA": "Holy See",
    "HN": "Honduras",
    "HK": "Hong Kong",
    "HU": "Hungary",
    "IS": "Iceland",
    "IN": "India",
    "ID": "Indonesia",
    "IR": "Iran",
    "IQ": "Iraq",
    "IE": "Ireland",
    "IM": "Isle of Man",
    "IL": "Israel",
    "IT": "Italy",
    "JM": "Jamaica",
    "JP": "Japan",
    "JE": "Jersey",
    "JO": "Jordan",
    "KZ": "Kazakhstan",
    "KE": "Kenya",
    "KI": "Kiribati",
    "KP": "North Korea",
    "KR": "South Korea",
    "KW": "Kuwait",
    "KG": "Kyrgyzstan",
    "LA": "Lao People's Democratic Republic",
    "LV": "Latvia",
    "LB": "Lebanon",
    "LS": "Lesotho",
    "LR": "Liberia",
    "LY": "Libya",
    "LI": "Liechtenstein",
    "LT": "Lithuania",
    "LU": "Luxembourg",
    "MO": "Macao",
    "MG": "Madagascar",
    "MW": "Malawi",
    "MY": "Malaysia",
    "MV": "Maldives",
    "ML": "Mali",
    "MT": "Malta",
    "MH": "Marshall Islands",
    "MQ": "Martinique",
    "MR": "Mauritania",
    "MU": "Mauritius",
    "YT": "Mayotte",
    "MX": "Mexico",
    "FM": "Micronesia",
    "MD": "Moldova",
    "MC": "Monaco",
    "MN": "Mongolia",
    "ME": "Montenegro",
    "MS": "Montserrat",
    "MA": "Morocco",
    "MZ": "Mozambique",
    "MM": "Myanmar",
    "NA": "Namibia",
    "NR": "Nauru",
    "NP": "Nepal",
    "NL": "Netherlands",
    "NC": "New Caledonia",
    "NZ": "New Zealand",
    "NI": "Nicaragua",
    "NE": "Niger",
    "NG": "Nigeria",
    "NU": "Niue",
    "NF": "Norfolk Island",
    "MK": "North Macedonia",
    "MP": "Northern Mariana Islands",
    "NO": "Norway",
    "OM": "Oman",
    "PK": "Pakistan",
    "PW": "Palau",
    "PS": "Palestine",
    "PA": "Panama",
    "PG": "Papua New Guinea",
    "PY": "Paraguay",
    "PE": "Peru",
    "PH": "Philippines",
    "PN": "Pitcairn",
    "PL": "Poland",
    "PT": "Portugal",
    "PR": "Puerto Rico",
    "QA": "Qatar",
    "RE": "Reunion",
    "RO": "Romania",
    "RU": "Russian Federation",
    "RW": "Rwanda",
    "BL": "Saint Barthelemy",
    "SH": "Saint Helena",
    "KN": "Saint Kitts and Nevis",
    "LC": "Saint Lucia",
    "MF": "Saint Martin",
    "PM": "Saint Pierre and Miquelon",
    "VC": "Saint Vincent and the Grenadines",
    "WS": "Samoa",
    "SM": "San Marino",
    "ST": "Sao Tome and Principe",
    "SA": "Saudi Arabia",
    "SN": "Senegal",
    "RS": "Serbia",
    "SC": "Seychelles",
    "SL": "Sierra Leone",
    "SG": "Singapore",
    "SX": "Sint Maarten",
    "SK": "Slovakia",
    "SI": "Slovenia",
    "SB": "Solomon Islands",
    "SO": "Somalia",
    "ZA": "South Africa",
    "GS": "South Georgia and the South Sandwich Islands",
    "SS": "South Sudan",
    "ES": "Spain",
    "LK": "Sri Lanka",
    "SD": "Sudan",
    "SR": "Suriname",
    "SJ": "Svalbard and Jan Mayen",
    "SE": "Sweden",
    "CH": "Switzerland",
    "SY": "Syrian Arab Republic",
    "TW": "Taiwan",
    "TJ": "Tajikistan",
    "TZ": "Tanzania",
    "TH": "Thailand",
    "TL": "Timor-Leste",
    "TG": "Togo",
    "TK": "Tokelau",
    "TO": "Tonga",
    "TT": "Trinidad and Tobago",
    "TN": "Tunisia",
    "TR": "Turkey",
    "TM": "Turkmenistan",
    "TC": "Turks and Caicos Islands",
    "TV": "Tuvalu",
    "UG": "Uganda",
    "UA": "Ukraine",
    "AE": "United Arab Emirates",
    "GB": "United Kingdom",
    "US": "United States of America",
    "UM": "United States Minor Outlying Islands",
    "UY": "Uruguay",
    "UZ": "Uzbekistan",
    "VU": "Vanuatu",
    "VE": "Venezuela",
    "VN": "Viet Nam",
    "VG": "Virgin Islands (British)",
    "VI": "Virgin Islands (U.S.)",
    "WF": "Wallis and Futuna",
    "EH": "Western Sahara",
    "YE": "Yemen",
    "ZM": "Zambia",
    "ZW": "Zimbabwe",
}


def parse_args():
    p = argparse.ArgumentParser(description="Statistiche blocco ASN da log")
    p.add_argument(
        "--source",
        type=str,
        default="auto",
        choices=["auto", "nginx", "kern"],
        help="Sorgente log: auto (nginx→kern), nginx, kern (default: auto)",
    )
    p.add_argument(
        "--top", type=int, default=30, help="Mostra i top N ASN (default: 30)"
    )
    p.add_argument(
        "--since", type=str, default=None, help="Filtra log da data (es: 'Mar 15')"
    )
    p.add_argument(
        "--log", type=str, default=None, help="File di log custom (override source)"
    )
    p.add_argument(
        "--json", action="store_true", help="Output JSON (progress su stderr)"
    )
    return p.parse_args()


def load_asn_descriptions():
    descs = {}
    try:
        with open(ASN_FILE, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("#", 1)
                asn = parts[0].strip().upper().lstrip("AS")
                desc = parts[1].strip() if len(parts) > 1 else ""
                descs[asn] = desc
    except FileNotFoundError:
        pass
    return descs


def load_country_db():
    try:
        return maxminddb.open_database(COUNTRY_MMDB)
    except Exception:
        return None


def parse_nginx_log(log_file, since=None):
    """Parsa nginx access.log estraendo ASN e countryCode dal log format main_geo.

    Formato nginx-template.conf:244-250:
      '"$geoip2_country_code $geoip2_country_name $geoip2_city_name" '
      '"AS$geoip2_asn" "$geoip2_isp"'

    Esempio riga:
      ... "IT Italy Milan" "AS12345" "ISP Name"
    """
    pattern = re.compile(r'"([A-Z]{2})\s+[^"]*"\s+"AS(\d+)"\s+"([^"]*)"')
    asn_counts = defaultdict(int)
    asn_country_code = {}
    asn_org = {}
    total_lines = 0

    try:
        with open(log_file, "r", errors="replace") as f:
            for line in f:
                if since and since not in line:
                    continue

                m = pattern.search(line)
                if not m:
                    continue

                cc = m.group(1)
                asn_num = m.group(2)
                org = m.group(3)

                total_lines += 1
                asn_counts[asn_num] += 1

                if asn_num not in asn_country_code:
                    asn_country_code[asn_num] = cc
                if asn_num not in asn_org:
                    asn_org[asn_num] = org

    except FileNotFoundError:
        print(f"ERRORE: file di log non trovato: {log_file}", file=sys.stderr)
        sys.exit(1)

    return asn_counts, asn_country_code, asn_org, total_lines


def parse_kern_log(log_file, since=None):
    """Estrae gli IP sorgente dalle righe [ASN-BLOCK] del log"""
    ip_pattern = re.compile(r"\[ASN-BLOCK\].*?SRC=(\d+\.\d+\.\d+\.\d+)")
    ip_counts = defaultdict(int)
    total_lines = 0

    try:
        with open(log_file, "r", errors="replace") as f:
            for line in f:
                if "[ASN-BLOCK]" not in line:
                    continue
                if since and since not in line:
                    continue
                m = ip_pattern.search(line)
                if m:
                    ip_counts[m.group(1)] += 1
                    total_lines += 1
    except FileNotFoundError:
        print(f"ERRORE: file di log non trovato: {log_file}", file=sys.stderr)
        sys.exit(1)

    return ip_counts, total_lines


def resolve_asn_from_ips(ip_counts, descs, country_db=None):
    """Associa IP a ASN tramite GeoIP e restituisce statistiche aggregate."""
    asn_hits = defaultdict(int)
    asn_ips = defaultdict(set)
    asn_org = {}
    asn_country = {}
    asn_country_code = {}
    unmatched = 0

    with maxminddb.open_database(MMDB) as db:
        for ip, count in ip_counts.items():
            try:
                result = db.get(ip)
                if result:
                    asn = str(result.get("autonomous_system_number", ""))
                    org = result.get("autonomous_system_organization", "")
                    if asn:
                        asn_hits[asn] += count
                        asn_ips[asn].add(ip)
                        if asn not in asn_org:
                            asn_org[asn] = org
                        if country_db and asn not in asn_country:
                            try:
                                cr = country_db.get(ip)
                                if cr:
                                    country_obj = (
                                        cr.get("country")
                                        or cr.get("registered_country")
                                        or {}
                                    )
                                    asn_country[asn] = (
                                        country_obj.get("names") or {}
                                    ).get("en", "")
                                    asn_country_code[asn] = country_obj.get(
                                        "iso_code", ""
                                    )
                            except Exception:
                                pass
                    else:
                        unmatched += count
                else:
                    unmatched += count
            except Exception:
                unmatched += count

    return asn_hits, asn_ips, asn_org, asn_country, asn_country_code, unmatched


def resolve_country_names_from_codes(asn_country_code):
    """Risolvi i nomi dei paesi dai codici ISO usando la mappa statica."""
    result = {}
    for asn_num, cc in asn_country_code.items():
        name = ISO2_NAMES.get(cc.upper(), "")
        if name:
            result[asn_num] = name
    return result


def build_json_output(top_asns, descs, asn_org, asn_country, asn_country_code):
    result = []
    for asn, hits in top_asns:
        result.append(
            {
                "asn": f"AS{asn}",
                "org": descs.get(asn) or asn_org.get(asn, ""),
                "country": asn_country.get(asn, ""),
                "countryCode": asn_country_code.get(asn, ""),
                "packets": hits,
                "bytes": 0,
            }
        )
    return result


def build_text_output(
    top_asns, asn_hits, asn_ips, descs, asn_org, total_hits, unmatched, ip_counts
):
    print(f"\n{'ASN':<12} {'Pacchetti':>10} {'%':>6} {'IP Univoci':>11}  Descrizione")
    print("-" * 75)

    for asn, hits in top_asns:
        pct = hits / total_hits * 100 if total_hits else 0
        uniq = len(asn_ips.get(asn, set()))
        desc = descs.get(asn) or asn_org.get(asn, "")
        print(f"AS{asn:<10} {hits:>10} {pct:>5.1f}% {uniq:>11}  {desc}")

    print("-" * 75)
    print(
        f"{'TOTALE':<12} {total_hits:>10} {'100%':>6} {len(ip_counts):>11}  IP univoci"
    )

    if unmatched:
        print(f"\n  Non classificati: {unmatched} pacchetti")

    if len(sorted(asn_hits.items(), key=lambda x: -x[1])) > len(top_asns):
        print(
            f"\n  (mostrati {len(top_asns)} su {len(asn_hits)} ASN — usa --top N per vedere di più)"
        )

    print()


def main():
    args = parse_args()

    def log(*a, **kw):
        out = sys.stderr if args.json else sys.stdout
        print(*a, file=out, **kw)

    if not args.json:
        print(f"\n{'=' * 65}")
        print(
            f"  Statistiche Blocco ASN — {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        )
        print(f"{'=' * 65}\n")

    descs = load_asn_descriptions()
    country_db = load_country_db() if args.json else None

    # Determina sorgente log
    source = args.source
    log_file = args.log

    if args.json:
        if source == "auto":
            source = "nginx"

    if source == "nginx" and not log_file:
        log_file = NGINX_LOG
    elif source == "kern" and not log_file:
        log_file = KERN_LOG

    log(f"[*] Sorgente: {source} ({log_file})...", flush=True)

    # Parse nginx log
    if source == "nginx":
        asn_counts, asn_country_code, asn_org, total_events = parse_nginx_log(
            log_file, args.since
        )

        if total_events == 0:
            if args.json:
                print(json.dumps([]))
            else:
                print("\nNessuna richiesta trovata nel log nginx.")
                print("Verifica che nginx stia scrivendo su", log_file)
            return

        log(
            f"[*] {total_events} richieste trovate, {len(asn_counts)} ASN univoci",
            flush=True,
        )

        # Risolvi nomi paesi dai codici ISO
        asn_country = resolve_country_names_from_codes(asn_country_code)

        sorted_asns = sorted(asn_counts.items(), key=lambda x: -x[1])
        top_asns = sorted_asns[: args.top]
        total_hits = sum(asn_counts.values())

        if args.json:
            result = build_json_output(
                top_asns, descs, asn_org, asn_country, asn_country_code
            )
            print(json.dumps(result))
            return

        build_text_output(
            top_asns,
            asn_counts,
            defaultdict(set),
            descs,
            asn_org,
            total_hits,
            0,
            asn_counts,
        )
        return

    # Parse kern log (fallback o esplicito)
    ip_counts, total_events = parse_kern_log(log_file, args.since)

    if total_events == 0:
        if args.json:
            print(json.dumps([]))
        else:
            print("\nNessun evento [ASN-BLOCK] trovato nel log kernel.")
            print("Attiva il logging con:")
            print("  iptables -I INPUT 1 -m set --match-set blocked_asn src \\")
            print(
                '    -m limit --limit 10/min --limit-burst 20 -j LOG --log-prefix "[ASN-BLOCK] " --log-level 4'
            )
        return

    log(f"[*] {total_events} eventi trovati da {len(ip_counts)} IP univoci", flush=True)

    log("[*] Associo IP agli ASN...", flush=True)
    asn_hits, asn_ips, asn_org, asn_country, asn_country_code, unmatched = (
        resolve_asn_from_ips(ip_counts, descs, country_db)
    )

    sorted_asns = sorted(asn_hits.items(), key=lambda x: -x[1])
    top_asns = sorted_asns[: args.top]
    total_hits = sum(asn_hits.values())

    if args.json:
        result = build_json_output(
            top_asns, descs, asn_org, asn_country, asn_country_code
        )
        print(json.dumps(result))
        return

    build_text_output(
        top_asns, asn_hits, asn_ips, descs, asn_org, total_hits, unmatched, ip_counts
    )


if __name__ == "__main__":
    main()
