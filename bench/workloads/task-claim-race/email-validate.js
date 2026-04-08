// Implement isValidEmail(s: string): boolean
//
// Validate an email address. Rules (a deliberate subset of RFC 5322):
//   - Format: <local>@<domain>
//   - <local> is 1+ characters from [a-zA-Z0-9._%+-], but cannot start or
//     end with a dot, and cannot contain consecutive dots.
//   - <domain> is 1+ labels separated by dots. Each label is 1-63 chars
//     from [a-zA-Z0-9-], and cannot start or end with a hyphen.
//   - There must be at least one dot in <domain> (i.e. a TLD).
//   - The TLD (last label) must be 2+ characters and only letters.
//   - Total length must be <= 254 characters.
//   - Anything else returns false. Never throw.
//
// Examples:
//   isValidEmail('a@b.co')              -> true
//   isValidEmail('user.name+tag@x.io')  -> true
//   isValidEmail('a@b')                 -> false  (no TLD)
//   isValidEmail('.a@b.co')             -> false  (leading dot in local)
//   isValidEmail('a..b@c.co')           -> false  (consecutive dots)
//   isValidEmail('a@-b.co')             -> false  (label starts with hyphen)
//   isValidEmail('a@b.c1')              -> false  (TLD has digit)
//   isValidEmail('')                    -> false

function isValidEmail(s) {
  throw new Error('TODO');
}

module.exports = { isValidEmail };
